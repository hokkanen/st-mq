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

test('empty histories are explicit arrays', () => assert.deepEqual(project({}), { timeline: [] }));

test('a zero-power status pulse is one entry with original event references', () => {
  const timeline = freeze(pulse()), result = project({ events: timeline });
  assert.equal(result.timeline.length, 1);
  const group = result.timeline[0];
  assert.equal(group.type, 'low-draw-pulse'); assert.equal(group.pulseCount, 1); assert.equal(group.count, 2);
  assert.equal(group.minPowerKw, 0); assert.equal(group.maxPowerKw, 0);
  assert.equal(group.events[0], timeline[0]); assert.equal(group.events[1], timeline[1]);
  assert.equal(group.startAt, T); assert.equal(group.endAt, T + 7000);
});

test('physical labels contradicted by low power are grouped without rewriting evidence', () => {
  const timeline = freeze(pulse(T, .05, 'physical')), before = JSON.stringify(timeline), group = project({ events: timeline }).timeline[0];
  assert.equal(group.type, 'low-draw-pulse'); assert.equal(group.maxPowerKw, .05);
  assert.equal(JSON.stringify(timeline), before);
});

test('adjacent brief pulses aggregate within 30 minutes and keep a stable first-event identity', () => {
  const first = pulse(), second = pulse(T + 20 * MINUTE, .1);
  const single = project({ events: first }).timeline[0], combined = project({ events: [...first, ...second] }).timeline[0];
  assert.equal(combined.id, single.id); assert.equal(combined.pulseCount, 2); assert.equal(combined.count, 4);
  assert.equal(combined.maxPowerKw, .1); assert.deepEqual(combined.events, [...first, ...second]);
  const unfinished = project({ events: [first[0]] }).timeline[0]; assert.equal(unfinished.id, single.id);
  assert.equal(project({ events: [...first, ...pulse(T + 31 * MINUTE)] }).timeline.length, 2);
});

test('missing, negative, positive draw and excessively long status changes are not brief low-draw pulses', () => {
  for (const powerKw of [null, undefined, NaN, -.1, .10001, 7]) {
    const timeline = pulse().map(row => ({ ...row, powerKw }));
    assert.equal(project({ events: timeline }).timeline.length, 2);
  }
  const long = pulse(); long[1].at = T + 2 * MINUTE + 1;
  assert.equal(project({ events: long }).timeline.length, 2);
  const mixed = [pulse()[0], pulse(T, 0, 'physical')[1]];
  assert.equal(project({ events: mixed }).timeline.length, 2);
});

test('important evidence and actions always separate otherwise adjacent pulse groups', () => {
  const barriers = [{ kind: 'physical', code: 'charging-observed', powerKw: 7 },
    { kind: 'physical', code: 'physical-unknown' }, { kind: 'evidence', code: 'observation-gap' },
    { kind: 'finding', code: 'unexpected-draw' }, { kind: 'control', code: 'manual', physicalKnown: false },
    { kind: 'session', code: 'disconnected' }, { kind: 'outcome', code: 'target-confirmed' },
    { kind: 'control', code: 'unavailable', physicalKnown: false, errorCode: 'charger-fault' }];
  for (const barrier of barriers) {
    const result = project({ events: [...pulse(), { ...barrier, at: T + MINUTE }, ...pulse(T + 2 * MINUTE)] });
    assert.equal(result.timeline.filter(row => row.type === 'low-draw-pulse').length, 2, barrier.code);
    assert.equal(result.timeline.some(row => row.events.some(event => event.code === barrier.code)), true);
  }
});

test('a fault or explicitly unknown power prevents a status pair from claiming a low-draw pulse', () => {
  for (const evidence of [{ faulted: true }, { physicalKnown: false }, { availability: 'unavailable' }, { reasonCode: 'manual-stop' }]) {
    const timeline = pulse(); Object.assign(timeline[0], evidence);
    assert.equal(project({ events: timeline }).timeline.some(row => row.type === 'low-draw-pulse'), false);
  }
});

test('unavailable and off chatter stays one unresolved evidence interval', () => {
  const timeline = [unavailable(), off(), unavailable(T + 15_000), off(T + 16_000)];
  const group = project({ events: timeline }).timeline[0];
  assert.equal(group.type, 'unavailable'); assert.equal(group.count, 4);
  assert.equal(group.open, true); assert.equal(group.closure, null); assert.equal(group.recoveredAt, null);
  assert.equal(group.endAt, null); assert.deepEqual(group.events, timeline);
});

test('off alone does not prove evidence recovery or an unavailable physical state', () => {
  const timeline = [{ kind: 'control', code: 'unavailable', at: T }, { kind: 'control', code: 'off', at: T + 1000 }];
  const groups = project({ events: timeline }).timeline;
  assert.equal(groups.length, 2); assert.equal(groups[0].recoveredAt, null); assert.equal(groups[0].closure, 'important-event');
  assert.equal(groups[1].type, 'event');
});

test('control availability alone never closes a documented physical evidence gap', () => {
  const timeline = [unavailable(), off(T + 1000, { availability: 'available', errorCode: null })];
  const group = project({ events: timeline }).timeline[0];
  assert.equal(group.count, 2); assert.equal(group.open, true); assert.equal(group.recoveredAt, null);
});

test('restored physical evidence closes unavailability and physical recovery is separately visible', () => {
  const restored = { kind: 'evidence', code: 'physical-evidence-restored', at: T + MINUTE, physicalKnown: true };
  const reading = { kind: 'physical', code: 'not-charging-observed', at: restored.at, powerKw: 0, source: 'easee', measuredAt: restored.at };
  const groups = project({ events: [unavailable(), off(), restored, reading] }).timeline;
  assert.equal(groups.length, 2); assert.equal(groups[0].recoveredAt, restored.at);
  assert.equal(groups[0].recoveryEvent, restored); assert.equal(groups[0].open, false); assert.equal(groups[0].closure, 'recovered');
  assert.equal(groups[0].events.at(-1), restored); assert.equal(groups[1].events[0], reading);
});

test('fresh attributed measured power can close a gap while stale or unattributed saved power cannot', () => {
  const reading = { kind: 'physical', code: 'not-charging-observed', at: T + MINUTE, powerKw: 0, source: 'easee', measuredAt: T + MINUTE };
  assert.equal(project({ events: [unavailable(), reading] }).timeline[0].recoveredAt, reading.at);
  for (const change of [{ source: undefined }, { measuredAt: T - 1 }, { measuredAt: T + 2 * MINUTE }, { powerKw: null }]) {
    const group = project({ events: [unavailable(), { ...reading, ...change }] }).timeline[0];
    assert.equal(group.recoveredAt, null);
  }
});

test('positive physical recovery on a control event remains valid when the error clears', () => {
  const recovery = off(T + MINUTE, { physicalKnown: true, availability: 'available', errorCode: null });
  const groups = project({ events: [unavailable(), recovery] }).timeline;
  assert.equal(groups[0].recoveredAt, recovery.at); assert.equal(groups[0].closure, 'recovered');
  assert.equal(groups[0].recoveryEvent, recovery);
});

test('observation gaps and session boundaries terminate grouping without inventing recovery', () => {
  for (const event of [{ kind: 'evidence', code: 'observation-gap' }, { kind: 'session', code: 'disconnected' }]) {
    const timeline = [unavailable(), { ...event, at: T + MINUTE }, off(T + 2 * MINUTE)];
    const groups = project({ events: timeline }).timeline;
    assert.equal(groups.length, 3); assert.equal(groups[0].open, false); assert.equal(groups[0].recoveredAt, null);
    assert.equal(groups[0].closure, event.kind === 'session' ? 'session-boundary' : 'observation-gap');
    assert.equal(groups[2].type, 'unavailable');
  }
});

test('permission, instruction and diagnosed-cause changes remain distinct during an outage', () => {
  for (const change of [{ automaticEnabled: true }, { chargeNow: true }, { errorCode: 'readback-failed' }, { reasonCode: 'manual-stop' }]) {
    const first = { ...unavailable(), reasonCode: 'read-failed' };
    const groups = project({ events: [first, off(T + MINUTE, change)] }).timeline;
    assert.equal(groups.length, 2, JSON.stringify(change)); assert.equal(groups[0].closure, 'important-event');
    assert.equal(groups[0].recoveredAt, null);
  }
});

test('a physical recovery status may start a low-draw pulse without hiding recovery evidence', () => {
  const pair = pulse(T + MINUTE); pair[0].physicalKnown = true;
  const groups = project({ events: [unavailable(), ...pair] }).timeline;
  assert.equal(groups.length, 2); assert.equal(groups[0].recoveredAt, pair[0].at);
  assert.equal(groups[1].type, 'low-draw-pulse'); assert.equal(groups[1].events[0], groups[0].recoveryEvent);
});

test('newest-first reverses outer records only, preserving chronological original details', () => {
  const first = pulse(), last = { kind: 'outcome', code: 'target-confirmed', at: T + MINUTE };
  const result = projectChargingReportHistory({ events: [...first, last] });
  assert.equal(result.timeline[0].events[0], last); assert.deepEqual(result.timeline[1].events, first);
});

test('equal-time distinct events get unique stable ids and absent times remain inspectable', () => {
  const a = { kind: 'control', code: 'off', at: T }, b = { ...a }, missing = { kind: 'physical', code: 'physical-unknown' };
  const groups = project({ events: [a, b, missing] }).timeline;
  assert.equal(new Set(groups.map(row => row.id)).size, 2);
  assert.equal(groups[0].count, 2);
  assert.equal(groups[1].startAt, null); assert.equal(groups[1].type, 'event');
  assert.equal(project({ events: [a, b, missing, { kind: 'outcome', code: 'target-confirmed', at: T + 1 }] }).timeline[0].id, groups[0].id);
});

test('identical control records group while different causes and intervening event ids remain barriers', () => {
  const control = { kind: 'control', code: 'pause-unconfirmed', basis: 'economic-pause', confirmed: false, errorCode: 'pause-unconfirmed' };
  const events = [1, 2, 4].map(id => ({ ...control, id, at: T + id }));
  events.push({ ...control, id: 5, at: T + 5, errorCode: 'invalid-plan' });
  const groups = project({ events }).timeline;
  assert.deepEqual(groups.map(row => row.events.length), [2, 1, 1]);
  assert.equal(groups.at(-1).events[0].errorCode, 'invalid-plan');
});

test('repeated pause confirmations and finding episodes group without a continuous failure claim', () => {
  const context = { basis: 'economic-pause', automaticEnabled: true, chargeNow: false, availability: 'available', physicalKnown: true, reasonCode: 'economic-wait', errorCode: null };
  const rows = [
    { kind: 'control', code: 'paused', confirmed: true, ...context },
    { kind: 'control', code: 'pause-unconfirmed', confirmed: false, ...context },
    { kind: 'finding', code: 'control-unconfirmed', episode: 1, context: { ...context, confirmed: false } },
    { kind: 'recovery', code: 'control-unconfirmed', episode: 1, context: { ...context, confirmed: true } },
    { kind: 'control', code: 'paused', confirmed: true, ...context },
    { kind: 'finding', code: 'control-unconfirmed', episode: 2, context: { ...context, confirmed: false } },
    { kind: 'control', code: 'pause-unconfirmed', ...context, errorCode: 'invalid-plan' },
    { kind: 'control', code: 'paused', ...context },
  ].map((row, index) => ({ ...row, at: T + index * MINUTE, id: index + 1 }));
  const frozen = freeze(rows), groups = project({ events: frozen }).timeline;
  assert.equal(groups.length, 3); assert.equal(groups[0].type, 'confirmation-series');
  assert.equal(groups[0].episodeCount, 2); assert.deepEqual(groups[0].events, rows.slice(0, 6));
  assert.equal(groups[0].recoveredAt, undefined);
  assert.equal(groups[1].events[0].errorCode, 'invalid-plan');
});

test('findings collect loaded episodes by onset cause and keep their own recovery evidence', () => {
  const events = [
    { kind: 'finding', code: 'control-unconfirmed', episode: 1, context: { basis: 'pause', confirmed: false, errorCode: 'readback-mismatch' } },
    { kind: 'recovery', code: 'control-unconfirmed', episode: 1, context: { basis: 'pause', confirmed: true, errorCode: null } },
    { kind: 'finding', code: 'control-unconfirmed', episode: 2, context: { basis: 'pause', confirmed: false, errorCode: 'readback-mismatch' } },
    { kind: 'finding', code: 'control-unconfirmed', episode: 3, context: { basis: 'pause', confirmed: false, errorCode: 'invalid-plan' } },
  ].map((row, index) => ({ ...row, id: index + 1, at: T + index }));
  const groups = projectChargingReportHistory({ events }, { filter: 'findings', order: 'oldest-first' }).timeline;
  assert.equal(groups.length, 2); assert.equal(groups[0].episodeCount, 2);
  assert.deepEqual(groups[0].events, events.slice(0, 3)); assert.equal(groups[1].events[0].context.errorCode, 'invalid-plan');
});

test('full plan snapshots stay attached to their one event and remain unchanged', () => {
  const snapshot = freeze(plan({ changes: [{ field: 'target', before: 80, after: 85 }] }));
  const event = freeze({ id: 8, at: T, kind: 'plan', code: 'target-update', plan: snapshot });
  const groups = project({ events: [event] }).timeline;
  assert.equal(groups.length, 1); assert.equal(groups[0].events[0].plan, snapshot);
});

test('report-local sequence ignores another charger but still preserves real omitted barriers', () => {
  const row = { at: T, kind: 'control', code: 'off', confirmed: false };
  const groups = project({ events: [{ ...row, id: 11, sequence: 1 }, { ...row, id: 15, sequence: 2 }, { ...row, id: 19, sequence: 4 }] }).timeline;
  assert.deepEqual(groups.map(group => group.count), [2, 1]);
});

test('a recovery-only page represents its episode without inventing an onset or zero episodes', () => {
  const events = [{ id: 50, at: T, kind: 'recovery', code: 'control-unconfirmed', episode: 9 }];
  const group = projectChargingReportHistory({ events }, { filter: 'findings' }).timeline[0];
  assert.equal(group.episodeCount, 1); assert.equal(group.startsMissing, true); assert.deepEqual(group.events, events);
});

test('All keeps a changed invalid-plan cause outside its earlier confirmation series', () => {
  const context = { basis: 'installed-execution', automaticEnabled: true, chargeNow: false, availability: 'available', physicalKnown: true, errorCode: null };
  const events = [
    { kind: 'control', code: 'paused', confirmed: true, ...context },
    { kind: 'finding', code: 'control-unconfirmed', episode: 1, context },
    { kind: 'finding-update', code: 'control-unconfirmed', episode: 1, context: { ...context, errorCode: 'invalid-plan' } },
    { kind: 'control', code: 'paused', confirmed: true, ...context },
  ].map((row, index) => ({ ...row, id: index + 1, at: T + index }));
  const groups = project({ events }).timeline;
  assert.equal(groups.length, 3); assert.equal(groups[0].type, 'confirmation-series');
  assert.deepEqual(groups[1].events, [events[2]]); assert.equal(groups[1].events[0].context.errorCode, 'invalid-plan');
});
