import test from 'node:test';
import assert from 'node:assert/strict';
import { projectChargingReportHistory } from '../chart/charging-report-history.js';

const T = Date.UTC(2026, 8, 30, 6), MINUTE = 60_000;
const project = report => projectChargingReportHistory(report, { order: 'oldest-first' });
const plan = (extra = {}) => ({ at: T, reason: 'initial-plan', automatic: false, chargeNow: false, state: 'disabled',
  scheduleState: 'none', inputStatus: 'available', deadlineAt: T + 24 * 60 * MINUTE, periods: [], vehicleId: null,
  inputs: { soc: { value: 20, source: 'manual-fallback', assumed: true, measuredAt: T },
    target: { value: 80, source: 'manual-fallback', assumed: true }, capacity: { value: 74, source: 'manual-fallback', assumed: true } },
  ...extra });
const pulse = (start = T, powerKw = 0, kind = 'charger-status') => [
  { at: start, kind, code: kind === 'physical' ? 'charging-observed' : 'charger-reports-charging', powerKw },
  { at: start + 7000, kind, code: kind === 'physical' ? 'charging-stopped' : 'charger-reports-not-charging', powerKw },
];
const unavailable = (at = T) => ({ kind: 'control', code: 'unavailable', at, physicalKnown: false,
  automaticEnabled: false, chargeNow: false, availability: 'unavailable', errorCode: 'read-failed' });
const off = (at = T + 1000, extra = {}) => ({ ...unavailable(at), code: 'off', ...extra });
function freeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
}

test('empty histories are explicit arrays', () => {
  assert.deepEqual(project({}), { timeline: [], plans: [], hiddenPlanEvents: [], hiddenPlans: [], hiddenPlanningCount: 0 });
});

test('only a baseline is shown when polling clocks, revisions and price hashes change', () => {
  const baseline = plan(), repeated = plan({ at: T + 15 * MINUTE, reason: 'price-update', revision: 72, priceHash: 'changed' });
  repeated.inputs.soc.measuredAt += 15 * MINUTE;
  const plans = [baseline, repeated], timeline = plans.map(row => ({ at: row.at, kind: 'plan', code: row.reason }));
  const report = freeze({ plans, timeline }), before = JSON.stringify(report), result = project(report);
  assert.deepEqual(result.plans, [baseline]); assert.equal(result.plans[0], baseline);
  assert.deepEqual(result.hiddenPlans, [repeated]); assert.equal(result.hiddenPlans[0], repeated);
  assert.deepEqual(result.hiddenPlanEvents, [timeline[1]]); assert.equal(result.hiddenPlanEvents[0], timeline[1]);
  assert.equal(result.hiddenPlanningCount, 1); assert.deepEqual(result.timeline[0].events, [timeline[0]]);
  assert.equal(JSON.stringify(report), before);
});

test('snapshots retain genuine input, source, target, schedule and setting changes without delta metadata', () => {
  const baseline = plan();
  const candidates = [
    { automatic: true }, { chargeNow: true }, { state: 'waiting' }, { scheduleState: 'installed' },
    { inputStatus: 'unavailable' }, { deadlineAt: baseline.deadlineAt + MINUTE }, { vehicleId: 'bmw' },
    { feasible: false }, { provisional: true }, { nativeStartAt: T + MINUTE, nativeStartKnown: true },
    { settings: { manualSoc: 30 } }, { periods: [{ startAt: T + MINUTE, endAt: null }] },
    { inputs: { ...baseline.inputs, soc: { value: 21, source: 'manual-fallback', assumed: true } } },
    { inputs: { ...baseline.inputs, target: { value: 90, source: 'session-request' } } },
    { inputs: { ...baseline.inputs, capacity: { value: 74, source: 'vehicle', assumed: false } } },
  ];
  for (const change of candidates) {
    const next = plan({ ...change, at: T + 1, reason: 'schedule-state' });
    assert.equal(project({ plans: [baseline, next] }).plans.length, 2, JSON.stringify(change));
  }
});

test('explicit concrete deltas preserve changes even when the complete snapshot lacks that field', () => {
  const baseline = plan(), changed = plan({ at: T + MINUTE, reason: 'price-update', changes: [
    { field: 'prices', before: [{ startAt: T, endAt: T + 60 * MINUTE, priceCtPerKwh: 3 }],
      after: [{ startAt: T, endAt: T + 60 * MINUTE, priceCtPerKwh: 7 }] },
  ] });
  assert.deepEqual(project({ plans: [baseline, changed] }).plans, [baseline, changed]);
  const noOp = { ...changed, changes: [{ field: 'target', before: 80, after: 80 }, { field: 'revision', before: 1, after: 2 }] };
  assert.deepEqual(project({ plans: [baseline, noOp] }).hiddenPlans, [noOp]);
});

test('elapsed periods and rolling open-release starts do not invent schedule changes', () => {
  const baseline = plan({ periods: [{ startAt: T, endAt: T + MINUTE }, { startAt: T + 2 * MINUTE, endAt: null }] });
  const next = plan({ at: T + 5 * MINUTE, periods: [{ startAt: T + 5 * MINUTE, endAt: null }] });
  assert.deepEqual(project({ plans: [baseline, next] }).hiddenPlans, [next]);
  const revised = { ...next, periods: [{ startAt: T + 6 * MINUTE, endAt: null }] };
  assert.equal(project({ plans: [baseline, revised] }).plans.length, 2);
});

test('price comparison ignores elapsed intervals but retains actual rate revisions and new coverage', () => {
  const interval = (startAt, endAt, priceCtPerKwh) => ({ startAt, endAt, priceCtPerKwh });
  const baseline = plan({ priceIntervals: [interval(T, T + MINUTE, 3), interval(T + MINUTE, T + 2 * MINUTE, 5)] });
  const next = plan({ at: T + MINUTE, priceIntervals: [interval(T + MINUTE, T + 2 * MINUTE, 5)] });
  assert.deepEqual(project({ plans: [baseline, next] }).hiddenPlans, [next]);
  for (const intervals of [[interval(T + MINUTE, T + 2 * MINUTE, 6)],
    [...next.priceIntervals, interval(T + 2 * MINUTE, T + 3 * MINUTE, 4)]]) {
    assert.equal(project({ plans: [baseline, { ...next, priceIntervals: intervals }] }).plans.length, 2);
  }
  assert.equal(project({ plans: [baseline, { ...next, priceIntervals: [] }] }).hiddenPlans.length, 1);
});

test('missing snapshots do not silently discard unsupported plan claims', () => {
  const timeline = [{ at: T, kind: 'plan', code: 'initial-plan' }, { at: T + MINUTE, kind: 'plan', code: 'price-update' }];
  assert.equal(project({ timeline }).timeline.length, 2);
});

test('an explicit event delta remains visible even if its paired snapshot is routine', () => {
  const repeated = plan({ at: T + MINUTE });
  const event = { at: repeated.at, kind: 'plan', code: 'target-update', changes: [{ field: 'target', before: 70, after: 80 }] };
  const result = project({ plans: [plan(), repeated], timeline: [event] });
  assert.equal(result.timeline[0].events[0], event); assert.equal(result.hiddenPlanEvents.length, 0);
});

test('a zero-power status pulse is one entry with original event references', () => {
  const timeline = freeze(pulse()), result = project({ timeline });
  assert.equal(result.timeline.length, 1);
  const group = result.timeline[0];
  assert.equal(group.type, 'low-draw-pulse'); assert.equal(group.pulseCount, 1); assert.equal(group.count, 2);
  assert.equal(group.minPowerKw, 0); assert.equal(group.maxPowerKw, 0);
  assert.equal(group.events[0], timeline[0]); assert.equal(group.events[1], timeline[1]);
  assert.equal(group.startAt, T); assert.equal(group.endAt, T + 7000);
});

test('physical labels contradicted by low power are grouped without rewriting evidence', () => {
  const timeline = freeze(pulse(T, .05, 'physical')), before = JSON.stringify(timeline), group = project({ timeline }).timeline[0];
  assert.equal(group.type, 'low-draw-pulse'); assert.equal(group.maxPowerKw, .05);
  assert.equal(JSON.stringify(timeline), before);
});

test('adjacent brief pulses aggregate within 30 minutes and keep a stable first-event identity', () => {
  const first = pulse(), second = pulse(T + 20 * MINUTE, .1);
  const single = project({ timeline: first }).timeline[0], combined = project({ timeline: [...first, ...second] }).timeline[0];
  assert.equal(combined.id, single.id); assert.equal(combined.pulseCount, 2); assert.equal(combined.count, 4);
  assert.equal(combined.maxPowerKw, .1); assert.deepEqual(combined.events, [...first, ...second]);
  const unfinished = project({ timeline: [first[0]] }).timeline[0]; assert.equal(unfinished.id, single.id);
  assert.equal(project({ timeline: [...first, ...pulse(T + 31 * MINUTE)] }).timeline.length, 2);
});

test('missing, negative, positive draw and excessively long status changes are not brief low-draw pulses', () => {
  for (const powerKw of [null, undefined, NaN, -.1, .10001, 7]) {
    const timeline = pulse().map(row => ({ ...row, powerKw }));
    assert.equal(project({ timeline }).timeline.length, 2);
  }
  const long = pulse(); long[1].at = T + 2 * MINUTE + 1;
  assert.equal(project({ timeline: long }).timeline.length, 2);
  const mixed = [pulse()[0], pulse(T, 0, 'physical')[1]];
  assert.equal(project({ timeline: mixed }).timeline.length, 2);
});

test('important evidence and actions always separate otherwise adjacent pulse groups', () => {
  const barriers = [{ kind: 'physical', code: 'charging-observed', powerKw: 7 },
    { kind: 'physical', code: 'physical-unknown' }, { kind: 'evidence', code: 'observation-gap' },
    { kind: 'finding', code: 'unexpected-draw' }, { kind: 'control', code: 'manual', physicalKnown: false },
    { kind: 'session', code: 'disconnected' }, { kind: 'outcome', code: 'target-confirmed' },
    { kind: 'control', code: 'unavailable', physicalKnown: false, errorCode: 'charger-fault' }];
  for (const barrier of barriers) {
    const result = project({ timeline: [...pulse(), { ...barrier, at: T + MINUTE }, ...pulse(T + 2 * MINUTE)] });
    assert.equal(result.timeline.filter(row => row.type === 'low-draw-pulse').length, 2, barrier.code);
    assert.equal(result.timeline.some(row => row.events.some(event => event.code === barrier.code)), true);
  }
});

test('a fault or explicitly unknown power prevents a status pair from claiming a low-draw pulse', () => {
  for (const evidence of [{ faulted: true }, { physicalKnown: false }, { availability: 'unavailable' }, { reasonCode: 'manual-stop' }]) {
    const timeline = pulse(); Object.assign(timeline[0], evidence);
    assert.equal(project({ timeline }).timeline.some(row => row.type === 'low-draw-pulse'), false);
  }
});

test('unavailable and off chatter stays one unresolved evidence interval', () => {
  const timeline = [unavailable(), off(), unavailable(T + 15_000), off(T + 16_000)];
  const group = project({ timeline }).timeline[0];
  assert.equal(group.type, 'unavailable'); assert.equal(group.count, 4);
  assert.equal(group.open, true); assert.equal(group.closure, null); assert.equal(group.recoveredAt, null);
  assert.equal(group.endAt, null); assert.deepEqual(group.events, timeline);
});

test('off alone does not prove evidence recovery or an unavailable physical state', () => {
  const timeline = [{ kind: 'control', code: 'unavailable', at: T }, { kind: 'control', code: 'off', at: T + 1000 }];
  const groups = project({ timeline }).timeline;
  assert.equal(groups.length, 2); assert.equal(groups[0].recoveredAt, null); assert.equal(groups[0].closure, 'important-event');
  assert.equal(groups[1].type, 'event');
});

test('control availability alone never closes a documented physical evidence gap', () => {
  const timeline = [unavailable(), off(T + 1000, { availability: 'available', errorCode: null })];
  const group = project({ timeline }).timeline[0];
  assert.equal(group.count, 2); assert.equal(group.open, true); assert.equal(group.recoveredAt, null);
});

test('restored physical evidence closes unavailability and physical recovery is separately visible', () => {
  const restored = { kind: 'evidence', code: 'physical-evidence-restored', at: T + MINUTE, physicalKnown: true };
  const reading = { kind: 'physical', code: 'not-charging-observed', at: restored.at, powerKw: 0, source: 'easee', measuredAt: restored.at };
  const groups = project({ timeline: [unavailable(), off(), restored, reading] }).timeline;
  assert.equal(groups.length, 2); assert.equal(groups[0].recoveredAt, restored.at);
  assert.equal(groups[0].recoveryEvent, restored); assert.equal(groups[0].open, false); assert.equal(groups[0].closure, 'recovered');
  assert.equal(groups[0].events.at(-1), restored); assert.equal(groups[1].events[0], reading);
});

test('fresh attributed measured power can close a gap while stale or unattributed saved power cannot', () => {
  const reading = { kind: 'physical', code: 'not-charging-observed', at: T + MINUTE, powerKw: 0, source: 'easee', measuredAt: T + MINUTE };
  assert.equal(project({ timeline: [unavailable(), reading] }).timeline[0].recoveredAt, reading.at);
  for (const change of [{ source: undefined }, { measuredAt: T - 1 }, { measuredAt: T + 2 * MINUTE }, { powerKw: null }]) {
    const group = project({ timeline: [unavailable(), { ...reading, ...change }] }).timeline[0];
    assert.equal(group.recoveredAt, null);
  }
});

test('positive physical recovery on a control event remains valid when the error clears', () => {
  const recovery = off(T + MINUTE, { physicalKnown: true, availability: 'available', errorCode: null });
  const groups = project({ timeline: [unavailable(), recovery] }).timeline;
  assert.equal(groups[0].recoveredAt, recovery.at); assert.equal(groups[0].closure, 'recovered');
  assert.equal(groups[0].recoveryEvent, recovery);
});

test('observation gaps and session boundaries terminate grouping without inventing recovery', () => {
  for (const event of [{ kind: 'evidence', code: 'observation-gap' }, { kind: 'session', code: 'disconnected' }]) {
    const timeline = [unavailable(), { ...event, at: T + MINUTE }, off(T + 2 * MINUTE)];
    const groups = project({ timeline }).timeline;
    assert.equal(groups.length, 3); assert.equal(groups[0].open, false); assert.equal(groups[0].recoveredAt, null);
    assert.equal(groups[0].closure, event.kind === 'session' ? 'session-boundary' : 'observation-gap');
    assert.equal(groups[2].type, 'unavailable');
  }
});

test('permission, instruction and diagnosed-cause changes remain distinct during an outage', () => {
  for (const change of [{ automaticEnabled: true }, { chargeNow: true }, { errorCode: 'readback-failed' }, { reasonCode: 'manual-stop' }]) {
    const first = { ...unavailable(), reasonCode: 'read-failed' };
    const groups = project({ timeline: [first, off(T + MINUTE, change)] }).timeline;
    assert.equal(groups.length, 2, JSON.stringify(change)); assert.equal(groups[0].closure, 'important-event');
    assert.equal(groups[0].recoveredAt, null);
  }
});

test('a physical recovery status may start a low-draw pulse without hiding recovery evidence', () => {
  const pair = pulse(T + MINUTE); pair[0].physicalKnown = true;
  const groups = project({ timeline: [unavailable(), ...pair] }).timeline;
  assert.equal(groups.length, 2); assert.equal(groups[0].recoveredAt, pair[0].at);
  assert.equal(groups[1].type, 'low-draw-pulse'); assert.equal(groups[1].events[0], groups[0].recoveryEvent);
});

test('newest-first reverses outer records only, preserving chronological original details', () => {
  const first = pulse(), last = { kind: 'outcome', code: 'target-confirmed', at: T + MINUTE };
  const result = projectChargingReportHistory({ timeline: [...first, last], plans: [plan(), plan({ at: T + MINUTE, vehicleId: 'bmw' })] });
  assert.equal(result.timeline[0].events[0], last); assert.deepEqual(result.timeline[1].events, first);
  assert.equal(result.plans[0].vehicleId, 'bmw');
});

test('equal-time distinct events get unique stable ids and absent times remain inspectable', () => {
  const a = { kind: 'control', code: 'off', at: T }, b = { ...a }, missing = { kind: 'physical', code: 'physical-unknown' };
  const groups = project({ timeline: [a, b, missing] }).timeline;
  assert.equal(new Set(groups.map(row => row.id)).size, 3);
  assert.equal(groups[2].startAt, null); assert.equal(groups[2].type, 'event');
  assert.equal(project({ timeline: [a, b, missing, { kind: 'outcome', code: 'target-confirmed', at: T + 1 }] }).timeline[0].id, groups[0].id);
});
