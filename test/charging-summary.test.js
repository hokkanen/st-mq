import test from 'node:test';
import assert from 'node:assert/strict';
import { chargerSummary } from '../chart/charging-summary.js';
import { chargerDisplay, chargingTime } from '../chart/charging.js';

const now = Date.parse('2026-09-15T18:00:00Z'), hour = 3_600_000;
const startAt = now + 2 * hour, finishAt = now + 7 * hour, deadlineAt = now + 9 * hour;
const reading = value => ({ value, available: value !== null, source: 'mqtt' });
function charger(patch = {}) {
  return { id: 'charger1', label: 'Charger 1', capabilities: { scheduling: true }, settings: { enabled: true },
    values: { connected: reading(true), soc: reading(40), minimumSoc: reading(85), scheduledStartAt: reading(startAt) },
    requiredGridKwh: 30, control: { phase: 'waiting', owned: { startAt } },
    plan: { state: 'waiting', startAt, finishAt, deadlineAt, feasible: true }, ...patch };
}
function summary(item) {
  return chargerSummary(item, chargerDisplay(item, { now }), { now, formatTime: value => chargingTime(value, 'Europe/Helsinki', now) });
}

test('controlled and observed roles share start activity and estimated target semantics', () => {
  const controlled = summary(charger());
  assert.equal(controlled.roleLabel, 'Controlled'); assert.equal(controlled.roleState, 'controlled');
  assert.equal(controlled.activity, 'Starts 23:00'); assert.equal(controlled.compactSummary, 'Controlled · Starts 23:00');
  assert.deepEqual(controlled.completion, { value: 'tomorrow 04:00', detail: 'Expected on time', at: finishAt });
  const observed = summary(charger({ capabilities: { scheduling: false }, plan: { state: 'observing' },
    forecast: { state: 'forecast', reason: 'automatic-current-forecast', finishAt } }));
  assert.equal(observed.roleLabel, 'Observed'); assert.equal(observed.activity, 'Scheduled start 23:00');
  assert.equal(observed.compactSummary, 'Observed · Scheduled start 23:00');
  assert.equal(observed.completion.value, controlled.completion.value);
});

test('turning automatic charging off changes the role and discards its old estimate', () => {
  const off = summary(charger({ settings: { enabled: false } }));
  assert.equal(off.roleLabel, 'Observed'); assert.match(off.roleDetail, /off/);
  assert.equal(off.completion.value, 'No estimate');
  const staleForecast = summary(charger({ settings: { enabled: false }, forecast: { state: 'planned', controlled: true, finishAt } }));
  assert.equal(staleForecast.completion.at, null);
  const currentNativeForecast = summary(charger({ settings: { enabled: false },
    forecast: { state: 'forecast', controlled: false, finishAt } }));
  assert.equal(currentNativeForecast.completion.at, finishAt);
});

test('live activity keeps charging and pause status while the ETA moves to its own column', () => {
  const item = charger(), values = { ...item.values, charging: reading(true), powerKw: reading(8.2) };
  const charging = summary({ ...item, values, control: { phase: 'released' }, forecast: { finishAt } });
  assert.equal(charging.activity, 'Charging · 8.2 kW now');
  assert.equal(charging.completion.at, finishAt); assert(!charging.compactSummary.includes('estimated'));
  const periods = [{ startAt: now - hour, endAt: now + hour }, { startAt, endAt: null }];
  const paused = summary({ ...item, values, plan: { ...item.plan, periods }, control: { phase: 'waiting', owned: { periods } } });
  assert.equal(paused.activity, 'Charging · 8.2 kW now · pauses 22:00');
  const between = summary({ ...item, plan: { ...item.plan, periods: [{ startAt: now - 2 * hour, endAt: now - hour }, periods[1]] },
    control: { phase: 'paused', owned: { periods: [{ startAt: now - 2 * hour, endAt: now - hour }, periods[1]] } } });
  assert.equal(between.activity, 'Paused between periods · Resumes 23:00');
});

test('manual priority preserves its window and uses only a current native estimate inside that window', () => {
  const control = { phase: 'yielded', manual: { kind: 'window', startsAt: startAt, windowEndAt: deadlineAt, resumeAt: deadlineAt } };
  const manual = summary(charger({ control }));
  assert.equal(manual.roleLabel, 'Manual override'); assert.equal(manual.roleState, 'manual');
  assert.match(manual.activity, /^Manual window 23:00–tomorrow 06:00$/);
  assert.equal(manual.completion.at, null, 'The old automatic plan is inactive');
  const current = summary(charger({ control, forecast: { state: 'forecast', reason: 'automatic-current-forecast', controlled: true, finishAt } }));
  assert.equal(current.completion.at, finishAt);
  const tooLate = summary(charger({ control, forecast: { state: 'forecast', finishAt: deadlineAt + hour } }));
  assert.equal(tooLate.completion.at, null); assert.equal(tooLate.completion.detail, 'Scheduled stop before target');
});

test('manual expiry, unknown ownership and handover failures never claim confirmed control', () => {
  for (const phase of ['uncertain', 'ownership-uncertain', 'unavailable', 'pause-unconfirmed', 'unconfirmed']) {
    const result = summary(charger({ control: { phase, owned: { startAt } } }));
    assert.equal(result.roleLabel, 'Control unconfirmed'); assert.equal(result.completion.value, 'Checking');
  }
  const unknown = summary(charger({ control: { phase: 'yielded', manual: { kind: 'unknown' } } }));
  assert.equal(unknown.roleLabel, 'Control unconfirmed');
  const expired = summary(charger({ control: { phase: 'yielded', manual: { kind: 'window', resumeAt: now - 1 } } }));
  assert.equal(expired.roleLabel, 'Handover pending'); assert.equal(expired.completion.at, null);
  const handover = summary(charger({ settings: { enabled: false }, control: { phase: 'off', handoverConfirmed: false } }));
  assert.equal(handover.roleLabel, 'Handover unconfirmed'); assert.equal(handover.roleState, 'uncertain');
});

test('a pending revision retains the confirmed start without using the proposed completion', () => {
  const item = charger({ plan: { startAt: startAt + hour, finishAt, deadlineAt } }), result = summary(item);
  assert.equal(result.roleLabel, 'Control unconfirmed');
  assert.equal(result.activity, 'Starts 23:00 · update awaiting confirmation');
  assert.equal(result.completion.at, null);
  const proposal = summary(charger({ control: { phase: 'unconfirmed' } }));
  assert.equal(proposal.activity, 'Proposed start 23:00'); assert.equal(proposal.completion.at, null);
});

test('explicit null forecasts and past finishes cannot revive old automatic estimates', () => {
  for (const forecast of [null, { finishAt: null }, { finishAt: now - 1 }, { state: 'unavailable', finishAt }]) {
    const result = summary(charger({ forecast }));
    assert.equal(result.completion.at, null); assert.equal(result.completion.value, 'Checking');
  }
  assert.equal(summary(charger({ plan: { startAt, finishAt, deadlineAt: now - 1 } })).completion.at, null);
});

test('native stop times are not target estimates and an early stop invalidates the forecast finish', () => {
  const item = charger({ capabilities: { scheduling: false }, plan: { state: 'observing' } });
  const values = { ...item.values, scheduledEndAt: reading(deadlineAt) };
  assert.equal(summary({ ...item, values, telemetry: { scheduledEndKind: 'scheduled-stop' } }).completion.at, null);
  const earlyStop = summary({ ...item, values: { ...values, scheduledEndAt: reading(startAt + hour) },
    telemetry: { scheduledEndKind: 'scheduled-stop' }, forecast: { state: 'forecast', finishAt } });
  assert.equal(earlyStop.completion.at, null); assert.equal(earlyStop.completion.detail, 'Scheduled stop before target');
  const informational = summary({ ...item, values: { ...values, scheduledEndAt: reading(startAt + hour) },
    telemetry: { scheduledEndKind: 'informational' }, forecast: { state: 'forecast', finishAt } });
  assert.equal(informational.completion.at, finishAt);
});

test('zero remaining energy wins over missing forecasts and preserves live charging status', () => {
  const item = charger(), result = summary({ ...item, forecast: { finishAt: null }, progress: { remainingGridKwh: 0 },
    values: { ...item.values, charging: reading(true), powerKw: reading(8) } });
  assert.equal(result.completion.value, 'Reached'); assert.equal(result.completion.at, null);
  assert.equal(result.activity, 'Charging · 8 kW now');
  assert.equal(result.compactSummary, 'Controlled · Charging · 8 kW now · Target reached');
});

test('disconnection and missing native activity suppress old vehicle forecasts', () => {
  const item = charger({ capabilities: { scheduling: false }, plan: { state: 'observing' }, forecast: { state: 'forecast', finishAt } });
  const disconnected = summary({ ...item, values: { ...item.values, connected: reading(false) } });
  assert.equal(disconnected.completion.detail, 'Not connected'); assert.match(disconnected.activity, /^Not connected/);
  const expiredSchedule = summary({ ...item, values: { ...item.values, scheduledStartAt: reading(now - hour) } });
  assert.equal(expiredSchedule.completion.at, null);
});

test('a valid late estimate remains explicitly at risk', () => {
  const late = summary(charger({ forecast: { finishAt: deadlineAt + hour, feasible: false, reason: 'insufficient-time' } }));
  assert.equal(late.completion.at, deadlineAt + hour); assert.equal(late.completion.detail, 'Target at risk');
});
