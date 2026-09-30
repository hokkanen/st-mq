import test from 'node:test';
import assert from 'node:assert/strict';
import { ChargingSessionDiagnostics } from '../src/charging/session-diagnostics.js';

const MINUTE = 60_000, START = Date.parse('2026-10-01T05:00:00Z');
const reading = (value, measuredAt = START, extra = {}) => ({ value, available: true,
  source: 'easee-ocpp', measuredAt, receivedAt: measuredAt, ...extra });

function fixture() {
  let now = START;
  const states = new Map(), store = { getState: key => structuredClone(states.get(key)),
    setState: (key, state) => states.set(key, structuredClone(state)) };
  let observer = new ChargingSessionDiagnostics({ store, key: 'physical-report', clock: () => now });
  const view = { id: 'charger1', association: 'synthetic-equipment', provider: 'easee',
    request: { sessionId: 'synthetic-connection', revision: 1 }, settings: { enabled: true },
    control: { phase: 'released', released: true, session: { connected: true, connectedAt: START - MINUTE },
      snapshot: { online: true, readAt: START } },
    values: { connected: reading(true), charging: reading(false), powerKw: reading(0),
      soc: reading(20, START, { source: 'manual-fallback', assumed: true }),
      minimumSoc: reading(80, START, { source: 'manual-fallback', assumed: true }),
      vehicleCeilingSoc: { available: false, value: null }, capacityKwh: reading(74), availableCurrentA: reading(16) },
    vehicle: { state: 'unidentified', id: null }, telemetry: { providerConnected: true },
    identification: { active: false, phase: 'inconclusive' }, deadlineAt: START + 8 * 60 * MINUTE,
    plan: { periods: [{ startAt: START - MINUTE, endAt: null }], feasible: true },
    progress: { connectionAt: START - MINUTE, remainingGridKwh: 20, deliveredGridKwh: 0,
      basis: { energyCoverageIncomplete: false, lastMeasuredAt: START } } };
  const observe = (at = now) => {
    now = at; view.control.snapshot.readAt = at;
    return observer.observe([view], at).chargers[0].current;
  };
  const power = (kw, at, extra = {}) => { view.values.powerKw = reading(kw, at, extra); };
  const reported = (charging, at, extra = {}) => { view.values.charging = reading(charging, at, extra); };
  const vehicle = (soc, target = 80, at = now) => {
    view.vehicle = { state: 'identified', id: 'bmw' }; view.vehicleMqtt = { available: true };
    view.values.soc = reading(soc, at, { source: 'bmw-cardata' });
    view.values.minimumSoc = reading(target, at, { source: 'bmw-cardata' });
    view.values.vehicleCeilingSoc = reading(target, at, { source: 'bmw-cardata' });
  };
  return { view, observe, power, reported, vehicle,
    restart: () => { observer = new ChargingSessionDiagnostics({ store, key: 'physical-report', clock: () => now }); } };
}

const physical = report => report.timeline.filter(row => row.kind === 'physical');

test('zero-power Charging status pulses remain state-machine observations without physical starts or successful release', () => {
  const f = fixture(); let report = f.observe();
  for (let index = 1; index <= 4; index++) {
    const at = START + index * 10_000;
    f.power(0, at); f.reported(index % 2 === 1, at); report = f.observe(at);
  }
  assert.equal(report.current.charging, false);
  assert.equal(report.current.reportedCharging, false);
  assert.equal(report.firstChargingAt, null);
  assert.equal(report.coverage.initialRelease.state, 'not-exercised');
  assert.deepEqual(physical(report).map(row => row.code), ['not-charging-observed']);
  assert.equal(report.timeline.filter(row => row.kind === 'charger-status' && row.code === 'charger-reports-charging').length, 2);
});

test('a small real metered pulse records physical start and stop with original source and receipt clocks', () => {
  const f = fixture(); f.observe();
  const measuredAt = START + 10_000, receivedAt = measuredAt + 2000, observedAt = receivedAt + 3000;
  f.power(.12, measuredAt, { receivedAt }); f.reported(true, measuredAt, { receivedAt });
  let report = f.observe(observedAt);
  const start = physical(report).find(row => row.code === 'charging-started');
  assert.ok(start); assert.equal(start.measuredAt, measuredAt); assert.equal(start.receivedAt, receivedAt);
  assert.equal(start.at, observedAt); assert.equal(start.powerKw, .12); assert.equal(start.source, 'easee-ocpp');
  assert.equal(report.coverage.initialRelease.state, 'verified');
  f.power(.02, START + 30_000); f.reported(false, START + 30_000); report = f.observe(START + 31_000);
  assert.ok(physical(report).some(row => row.code === 'charging-stopped' && row.powerKw === .02));
  assert.equal(report.coverage.completion.state, 'not-exercised', 'Measured draw includes auxiliaries and does not alone prove battery completion');
});

test('status alone and missing, stale, replayed, assumed or preconnection power cannot prove physical charging', () => {
  for (const scenario of ['missing', 'stale', 'retained', 'assumed', 'preconnection', 'future', 'no-clock']) {
    const f = fixture(); f.reported(true, START);
    f.power(7, START);
    if (scenario === 'missing') f.view.values.powerKw.available = false;
    if (scenario === 'stale') { f.view.values.powerKw.measuredAt = START - 3 * MINUTE; f.view.values.powerKw.receivedAt = START; }
    if (scenario === 'retained') f.view.values.powerKw.retained = true;
    if (scenario === 'assumed') f.view.values.powerKw.assumed = true;
    if (scenario === 'preconnection') f.view.values.powerKw.measuredAt = START - MINUTE - 1;
    if (scenario === 'future') f.view.values.powerKw.measuredAt = START + 1;
    if (scenario === 'no-clock') { delete f.view.values.powerKw.measuredAt; delete f.view.values.powerKw.receivedAt; }
    const report = f.observe();
    assert.equal(report.current.charging, null, scenario);
    assert.equal(report.current.reportedCharging, true, scenario);
    assert.equal(report.firstChargingAt, null, scenario);
    assert.equal(report.coverage.initialRelease.state, 'not-exercised', scenario);
    assert.ok(!physical(report).some(row => ['charging-started', 'charging-stopped'].includes(row.code)), scenario);
  }
});

test('initial idle state and recovery after unknown telemetry are observations rather than witnessed stop transitions', () => {
  const f = fixture(); let report = f.observe();
  assert.deepEqual(physical(report).map(row => row.code), ['not-charging-observed']);
  f.power(5, START + 10_000); report = f.observe(START + 10_000);
  f.view.values.powerKw.available = false; report = f.observe(START + 20_000);
  f.power(0, START + 30_000); report = f.observe(START + 30_000);
  assert.deepEqual(physical(report).map(row => row.code), ['not-charging-observed', 'charging-started', 'physical-unknown', 'not-charging-observed']);
});

test('a telemetry gap cannot become a witnessed start or stop even if the resumed power reading differs', () => {
  for (const [before, after] of [[7, 0], [0, 7]]) {
    const f = fixture(); f.power(before, START); f.observe();
    f.power(after, START + 5 * MINUTE);
    const report = f.observe(START + 5 * MINUTE);
    assert.ok(report.timeline.some(row => row.code === 'observation-gap'));
    assert.equal(physical(report).at(-1).code, after === 0 ? 'not-charging-observed' : 'charging-observed');
  }
});

test('held charger state preserves its old measurement clock independently of newer power and observation clocks', () => {
  const f = fixture(), measuredAt = START - 30 * MINUTE, receivedAt = START - MINUTE;
  f.reported(true, measuredAt, { receivedAt }); f.power(0, START);
  const report = f.observe(START + 10_000);
  const status = report.timeline.find(row => row.kind === 'charger-status' && row.code === 'charger-reports-charging');
  assert.equal(status.measuredAt, measuredAt); assert.equal(status.receivedAt, receivedAt);
  assert.equal(status.at, START + 10_000); assert.equal(status.powerMeasuredAt, START);
  assert.equal(report.current.charging, false);
});

test('a confirmed vehicle target survives restart, absent feed and fallback display values', () => {
  const f = fixture(); f.vehicle(95, 90); let report = f.observe();
  assert.equal(report.outcome.target, 90); assert.equal(report.outcome.state, 'target-confirmed');
  f.restart(); f.view.control.snapshot.online = false; f.view.vehicleMqtt.available = false;
  f.view.vehicle = { state: 'unidentified', id: null }; f.view.request = null;
  f.view.values.minimumSoc = reading(80, START, { source: 'manual-fallback', assumed: true });
  f.view.values.soc = reading(20, START, { source: 'manual-fallback', assumed: true });
  report = f.observe(START + MINUTE);
  assert.equal(report.outcome.state, 'target-confirmed'); assert.equal(report.outcome.target, 90);
  assert.equal(report.coverage.targetAttainment.state, 'verified');
  assert.equal(report.current.physicalFresh, false);
});

test('a real target raise withdraws earlier success until the raised target is reached', () => {
  const f = fixture(); f.vehicle(80, 80); f.observe();
  f.vehicle(85, 90, START + 10_000); let report = f.observe(START + 10_000);
  assert.equal(report.outcome.state, 'in-progress'); assert.equal(report.coverage.targetAttainment.state, 'not-exercised');
  f.vehicle(90, 90, START + 20_000); report = f.observe(START + 20_000);
  assert.equal(report.outcome.state, 'target-confirmed'); assert.equal(report.outcome.target, 90);
});

test('loss of vehicle target evidence while the charger stays live cannot replace confirmed outcome with a fallback', () => {
  for (const identityKnown of [true, false]) {
    const f = fixture(); f.vehicle(95, 90); f.observe();
    if (!identityKnown) f.view.vehicle = { state: 'unidentified', id: null };
    f.view.vehicleMqtt.available = false;
    f.view.values.minimumSoc = reading(80, START, { source: 'manual-fallback', assumed: true });
    f.view.values.soc = reading(20, START, { source: 'manual-fallback', assumed: true });
    f.power(0, START + MINUTE);
    const report = f.observe(START + MINUTE);
    assert.equal(report.current.physicalFresh, true);
    assert.equal(report.outcome.state, 'target-confirmed');
    assert.equal(report.outcome.target, 90);
    assert.equal(report.coverage.targetAttainment.state, 'verified');
  }
});

test('a raised target already satisfied by fresh vehicle evidence updates the confirmed outcome target', () => {
  const f = fixture(); f.vehicle(95, 80); f.observe();
  f.vehicle(95, 90, START + 10_000); const report = f.observe(START + 10_000);
  assert.equal(report.outcome.state, 'target-confirmed');
  assert.equal(report.outcome.target, 90, 'The confirmed outcome must describe the currently attained target');
  assert.equal(report.coverage.targetAttainment.at, START + 10_000, 'An earlier lower target cannot date the new target confirmation');
  assert.equal(report.outcome.at, START + 10_000);
});

test('near-zero idle draw and manual or unidentified battery values do not prove native completion', () => {
  for (const scenario of ['unidentified', 'manual', 'feed-offline', 'retained-vehicle']) {
    const f = fixture(); f.vehicle(100, 80); f.power(.02, START);
    if (scenario === 'unidentified') f.view.vehicle = { id: null, state: 'unidentified' };
    if (scenario === 'manual') { f.view.values.soc.source = 'session-anchor'; f.view.values.soc.assumed = true; }
    if (scenario === 'feed-offline') f.view.vehicleMqtt.available = false;
    if (scenario === 'retained-vehicle') f.view.values.soc.retained = true;
    const report = f.observe();
    assert.equal(report.coverage.completion.state, 'not-exercised', scenario);
    assert.notEqual(report.outcome.state, 'target-confirmed', scenario);
  }
});
