import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chargerDisplay, chargingDisplay, chargingContext, chargingFields, chargingTime, chargingReadingTime, createChargingPanel } from '../chart/charging.js';
import { DEFAULT_CHARGING_SETTINGS } from '../src/charging/settings.js';

const now = Date.parse('2026-09-15T18:00:00Z'), startAt = now + 2 * 3600_000, deadlineAt = now + 9 * 3600_000;
const reading = (value, source = 'teslamate', extra = {}) => ({ value, source, available: value != null, ...extra });
function charger(id = 'charger1', patch = {}) {
  return { id, label: id === 'charger1' ? 'Charger 1' : 'Charger 2',
    provider: id === 'charger1' ? 'easee' : 'shelly-evse',
    settings: { enabled: false, ...structuredClone(DEFAULT_CHARGING_SETTINGS.chargers[id]) }, controls: { enabled: false, revision: 0 }, capabilities: { scheduling: true, currentControl: id === 'charger2' },
    values: { soc: reading(20, 'manual-fallback'), minimumSoc: reading(80, 'manual-fallback'),
      capacityKwh: reading(id === 'charger1' ? 74 : 57, 'manual-fallback'), connected: reading(null) },
    association: `fixture:${id}`, request: { sessionId: `session:${id}`, revision: 1, overrides: {} },
    requiredGridKwh: 32.888, ...patch };
}
const status = (...chargers) => ({ role: 'master', now, charging: { settings: { priority: 'balanced', ...structuredClone(DEFAULT_CHARGING_SETTINGS) }, controls: { priority: 'balanced', revision: 0 },
  timezone: 'Europe/Helsinki', chargers: chargers.length ? chargers : [charger(), charger('charger2')] } });
const connected = (id = 'charger1') => { const item = charger(id); return { ...item, values: { ...item.values, connected: reading(true) } }; };
const sessionPayload = (id, changes, extra = {}) => ({ scope: 'session', association: `fixture:${id}`, sessionId: `session:${id}`, revision: 1, changes, ...extra });
const view = item => chargerDisplay(item, { now });
const active = () => { const item = charger(); return { ...item, settings: { ...item.settings, enabled: true },
  values: { ...item.values, connected: reading(true) }, plan: { startAt, finishAt: deadlineAt, deadlineAt } }; };

test('assumed current keeps proposed periods visible while charger control is unavailable', () => {
  const item = { ...active(), id: 'charger2', provider: 'shelly-evse', control: { phase: 'unavailable', reason: 'evse-read-unavailable' },
    identification: { active: true, phase: 'waiting', reason: 'charger-unavailable' },
    plan: { startAt, finishAt: deadlineAt - 3600000, deadlineAt, feasible: true,
      assumptions: [{ code: 'maximum-available-current', maximumCurrentA: 16, source: 'configured-maximum' }],
      periods: [{ startAt, endAt: null }] } };
  const display = view(item);
  assert.match(display.readiness, /Estimate only.*control unconfirmed/);
  assert.equal(display.periodRows.length, 1);
  assert.ok(display.rows.some(([name, value]) => name === 'Planning current' && /16 A per phase.*assumed/.test(value)));
  assert.ok(display.notes.some(note => /periods are proposed/.test(note)));
  assert.doesNotMatch(display.state, /Paused|Scheduled/);
});
function bmwTarget({ conflict = true, connectedAt = now - 60_000, rawValue = 100 } = {}) {
  const item = active(), source = conflict ? 'bmw-target-filter' : 'bmw-cardata';
  const selected = { value: conflict ? 85 : rawValue, source, measuredAt: now - 30_000, receivedAt: now, readingId: 'target-selected' };
  return { ...item, vehicle: { state: 'identified', id: 'bmw', label: 'BMW', source: 'bmw-cardata' },
    values: { ...item.values, minimumSoc: reading(selected.value, source, { ...selected, provider: 'bmw-cardata' }) },
    targetSelection: { connectedAt, conflict, selected, lower: { ...selected, value: 85 },
      raw: { value: rawValue, measuredAt: now, receivedAt: now, readingId: 'target-raw' } } };
}

test('garage keeps pipe protection separate and renders shared charger cards above more equipment', () => {
  const html = readFileSync(new URL('../chart/index.html', import.meta.url), 'utf8');
  assert(!html.includes('id="home-heat-pump-title"'));
  assert.match(html, /id="garage-title">Garage<span class="zone-expand" aria-hidden="true"><\/span><\/h2>/);
  assert.equal((html.match(/data-h66-summary="mode"/g) ?? []).length, 1);
  assert(!html.includes('home-tariff-status'));
  assert(!html.includes('id="garage-budget-front"')); assert(html.includes('id="garage-reserve-front"'));
  assert(html.indexOf('id="garage-control"') < html.indexOf('id="charging-devices"'));
  assert(html.indexOf('id="charging-devices"') < html.indexOf('id="garage-equipment-details"'));
  assert.equal(html.split('id="charging-devices"').length - 1, 1, 'Chargers are mounted once in the Garage card');
  assert(!html.includes('id="charger1-settings-form"'), 'Per-charger forms come from the same renderer');
  assert(!html.includes('charging-installation'));
});

test('only local charger preferences are editable, with SoC following the same fallback field pattern', () => {
  assert.deepEqual(chargingFields.map(field => field.key), ['readyBy', 'manualSoc', 'minimumSoc', 'capacityKwh']);
  assert.equal(chargingFields.find(field => field.key === 'manualSoc').reading, 'soc');
  assert(chargingFields.find(field => field.key === 'manualSoc').automatic);
});

test('both chargers use the same compact model and retain useful energy information with control off', () => {
  const original = charger(), renamed = { ...original, id: 'another-charger', label: 'Another charger' };
  const first = view(original), second = view(renamed);
  assert.deepEqual({ ...first, id: second.id, label: second.label }, second);
  assert.equal(first.soc, '20 %'); assert.equal(first.socSource, 'Configured starting charge'); assert.equal(first.gridEnergy, '32.9 kWh');
  assert.equal(chargingDisplay(status().charging, now).chargers.length, 2);
  assert.equal(view(charger('charger2')).event, 'Automatic charging OFF');
  assert(!first.rows.some(([label]) => ['Current charge', 'Minimum charge', 'Grid energy to minimum'].includes(label)), 'Do not repeat overview metrics');
});

test('times use the application timezone with concise calendar dates across DST', () => {
  assert.equal(chargingTime(startAt, 'Europe/Helsinki', now), '23:00');
  assert.equal(chargingTime(deadlineAt, 'Europe/Helsinki', now), 'tomorrow 06:00');
  assert.equal(chargingTime(now + 3 * 86400_000, 'Europe/Helsinki', now), '18 Sept 21:00');
  const autumn = Date.parse('2026-10-24T22:30:00Z');
  assert.equal(chargingTime(Date.parse('2026-10-25T22:15:00Z'), 'Europe/Helsinki', autumn), 'tomorrow 00:15');
  const item = active(), input = status(item).charging; input.timezone = 'UTC';
  assert.match(chargingDisplay(input, now).chargers[0].event, /20:00/);
});

test('unfolded charge reading includes original date and time, distinguishing receipt time', () => {
  const state = active(), measuredAt = now - 120 * 86400_000;
  const measured = view({ ...state, values: { ...state.values, soc: reading(35, 'mqtt', { measuredAt, receivedAt: now }) } });
  assert.equal(measured.readingTime, `Charge measured ${chargingReadingTime(measuredAt, 'Europe/Helsinki')}`);
  assert.match(measured.readingTime, /18 May 2026, 21:00/);
  assert(!measured.rows.some(([label]) => label === 'Charge reading'));
  const received = view({ ...state, values: { ...state.values, soc: reading(35, 'teslamate', { measuredAt: null, receivedAt: now }) },
    telemetry: { fields: { geofence: { value: 'Not user-facing metadata' }, charge_current_request: { value: 13 } } } });
  assert.match(received.readingTime, /Charge received 15 Sept 2026, 21:00 · measurement time unknown/);
  assert(!JSON.stringify(received).includes('Not user-facing metadata'));
});

test('confirmed and proposed starts are distinguished without repeating schedule rows', () => {
  const state = active();
  assert.equal(view({ ...state, control: { phase: 'unconfirmed' } }).event, 'Proposed start 23:00');
  assert.equal(view({ ...state, control: { phase: 'waiting', owned: { startAt } } }).event, 'Starts 23:00');
  const revised = view({ ...state, plan: { ...state.plan, startAt: startAt + 3600_000 }, control: { phase: 'waiting', owned: { startAt } } });
  assert.equal(revised.event, 'Starts 23:00 · update awaiting confirmation');
  assert(!revised.rows.some(([label]) => /start/i.test(label)));
  assert.equal(revised.deadline, 'Ready by tomorrow 06:00');
});

test('charging shows live power and remaining completion estimate without stale planned timestamps', () => {
  const item = active(), earlierFinish = deadlineAt - 3600_000;
  const displayed = view({ ...item, values: { ...item.values, charging: reading(true), powerKw: reading(8.2),
    scheduledStartAt: reading(startAt), scheduledEndAt: reading(deadlineAt) }, control: { phase: 'released' }, forecast: { finishAt: earlierFinish } });
  assert.equal(displayed.state, 'Charging'); assert.equal(displayed.event, '8.2 kW now · 80 % estimated tomorrow 05:00');
  assert(!displayed.rows.some(([label]) => /start|minimum reached|ready by|end|stopping|power/i.test(label)));
  assert(!JSON.stringify(displayed.rows).includes('23:00'));
  const met = view({ ...item, requiredGridKwh: 0, values: { ...item.values, charging: reading(true), powerKw: reading(8.2) } });
  assert.match(met.event, /target reached$/);
});

test('a manual window is shown once, suppressing native duplicates and inactive automatic plans', () => {
  const item = active(), control = { phase: 'yielded', manual: { kind: 'window', startsAt: startAt, resumeAt: deadlineAt, repeating: true } };
  const displayed = view({ ...item, control, values: { ...item.values, scheduledStartAt: reading(startAt), scheduledEndAt: reading(deadlineAt) },
    telemetry: { scheduledEndKind: 'scheduled-stop' } });
  assert.equal(displayed.state, 'Manual schedule');
  assert.equal(displayed.event, 'Manual window 23:00–tomorrow 06:00');
  assert.equal(displayed.eventKind, 'manual');
  assert(!displayed.rows.some(([label]) => /start|ready|window|end|resume/i.test(label)));
  assert.equal(displayed.priority, 'Automatic control resumes tomorrow 06:00.');
  assert.equal(displayed.deadline, '', 'The automatic deadline is inactive during manual priority');
  const charging = view({ ...item, control, values: { ...item.values, charging: reading(true), powerKw: reading(8.2) } });
  assert.equal(charging.event, '8.2 kW now · Manual window 23:00–tomorrow 06:00');
});

test('faults and failed confirmation show actionable control status without claiming manual takeover', () => {
  const item = active();
  for (const phase of ['unavailable', 'unconfirmed']) {
    const result = view({ ...item, control: { phase, errorCode: 'read-failed', reason: 'Easee did not respond. The last schedule is unchanged.' } });
    assert.equal(result.state, 'Control unavailable'); assert.match(result.problem, /^Easee did not respond/);
    assert.equal(result.yielded, false); assert(!result.event.includes('Proposed')); assert.equal(result.eventAt, null);
  }
  assert.equal(view({ ...charger(), control: { phase: 'off', handoverConfirmed: false } }).state, 'Handover unconfirmed');
});

test('disconnected cards hide vehicle metrics and plans while preserving live cycle priority', () => {
  const item = active(), manual = { kind: 'window', startsAt: startAt, resumeAt: deadlineAt };
  const off = view({ ...item, settings: { ...item.settings, enabled: false }, control: { phase: 'yielded', manual } });
  assert.equal(off.yielded, false); assert.equal(off.deadline, ''); assert.equal(off.periodRows.length, 0);
  const disconnected = view({ ...item, values: { ...item.values, connected: reading(false) }, control: { phase: 'yielded', manual } });
  assert.equal(disconnected.state, 'Not connected'); assert.equal(disconnected.showMetrics, false);
  assert.equal(disconnected.yielded, true); assert.match(disconnected.event, /Automatic control resumes/);
  assert.equal(disconnected.eventAt, null); assert.equal(disconnected.deadline, ''); assert.equal(disconnected.periodRows.length, 0);
});

test('a read-only charger shows one verified native window while connected', () => {
  const item = charger('charger2'), scheduled = { ...item, values: { ...item.values, connected: reading(true),
    scheduledStartAt: reading(startAt), scheduledEndAt: reading(deadlineAt) }, telemetry: { scheduledEndKind: 'scheduled-stop' } };
  assert.equal(view(scheduled).event, 'Scheduled 23:00–tomorrow 06:00');
  assert.equal(chargingContext(status(scheduled).charging, now), 'Charger 2: Scheduled 23:00–tomorrow 06:00.');
  const away = { ...scheduled, values: { ...scheduled.values, connected: reading(false), charging: reading(true), powerKw: reading(8.2) } };
  assert.equal(view(away).state, 'Not connected'); assert.equal(view(away).event, 'Automatic charging OFF');
  assert.equal(chargingContext(status(away).charging, now), '');
  const tomorrow = { ...scheduled, values: { ...scheduled.values, scheduledStartAt: reading(deadlineAt), scheduledEndAt: reading(deadlineAt + 3600_000) } };
  assert.equal(view(tomorrow).event, 'Scheduled tomorrow 06:00–07:00');
  const charging = { ...scheduled, values: { ...scheduled.values, charging: reading(true), powerKw: reading(8.2) } };
  assert.equal(view(charging).event, '8.2 kW now · scheduled until tomorrow 06:00');
});

test('automatic source hints replace repeated fallback assumptions in the fold', () => {
  const item = active(), result = view({ ...item, plan: { ...item.plan, warnings: [
    'Charger 1: usable battery capacity uses the manual fallback.',
    'Charger 1: the remembered manual battery percentage is used until vehicle telemetry is available.',
    'Electricity prices are unavailable.',
  ] } });
  assert.deepEqual(result.notes, ['Electricity prices are unavailable.']);
});

test('confirmed periods describe the next pause or resumption and keep the final period unrestricted', () => {
  const item = active(), periods = [{ startAt: now - 3600_000, endAt: now + 1800_000 }, { startAt, endAt: null }];
  const current = view({ ...item, plan: { ...item.plan, periods }, control: { phase: 'active', owned: null, execution: { periods } },
    values: { ...item.values, charging: reading(true), powerKw: reading(8.2) } });
  assert.equal(current.event, '8.2 kW now · pauses 21:30'); assert.equal(current.periodCount, '2 charging periods');
  assert.deepEqual(current.periodRows, [['Period 1', '20:00–21:30'], ['Period 2', '23:00 onwards · vehicle finishes naturally']]);
  const pausedPeriods = [{ startAt: now - 3600_000, endAt: now - 1800_000 }, { startAt, endAt: null }];
  const paused = view({ ...item, plan: { ...item.plan, periods: pausedPeriods }, control: { phase: 'paused', owned: { startAt, periods: pausedPeriods } } });
  assert.equal(paused.state, 'Paused between periods'); assert.equal(paused.event, 'Resumes 23:00');
  assert.equal(paused.deadline, 'Ready by tomorrow 06:00');
  const released = view({ ...item, control: { phase: 'released' }, values: { ...item.values, charging: reading(true), powerKw: reading(8.2) } });
  assert(!released.event.includes('pauses')); assert.equal(released.periodRows.length, 0);
});

test('an idle vehicle stays allowed throughout each confirmed charging period, including its start boundary', () => {
  const at = clock => Date.parse(`2026-09-26T${clock}+03:00`);
  const periods = [{ startAt: at('01:00'), endAt: at('02:30') }, { startAt: at('03:30'), endAt: at('04:00') },
    { startAt: at('04:20'), endAt: null }];
  const item = active(), plan = { id: 'confirmed-periods', periods, deadlineAt: at('06:00') };
  const control = { confirmed: true, owned: { startAt: periods[0].startAt }, execution: { planId: plan.id, periods } };
  const expectedPeriods = [['Period 1', '01:00–02:30'], ['Period 2', '03:30–04:00'], ['Period 3', '04:20 onwards · vehicle finishes naturally']];
  for (const [clock, phase, state, event] of [
    ['00:59:59.999', 'waiting', 'Scheduled', 'Starts 01:00'],
    ['01:00', 'active', 'Connected', 'Charging is allowed'],
    ['02:15', 'active', 'Connected', 'Charging is allowed'],
    ['02:29:59.999', 'active', 'Connected', 'Charging is allowed'],
    ['02:30', 'paused', 'Paused between periods', 'Resumes 03:30'],
    ['03:29:59.999', 'paused', 'Paused between periods', 'Resumes 03:30'],
    ['03:30', 'active', 'Connected', 'Charging is allowed'],
    ['03:45', 'active', 'Connected', 'Charging is allowed'],
    ['03:59:59.999', 'active', 'Connected', 'Charging is allowed'],
    ['04:00', 'paused', 'Paused between periods', 'Resumes 04:20'],
    ['04:19:59.999', 'paused', 'Paused between periods', 'Resumes 04:20'],
    ['04:20', 'active', 'Connected', 'Charging is allowed'],
  ]) for (const charging of [false, null]) {
    const owned = phase === 'paused' ? { startAt: periods.find(period => period.startAt > at(clock)).startAt } : control.owned;
    const result = chargerDisplay({ ...item, plan, control: { ...control, owned, phase },
      values: { ...item.values, charging: reading(charging), minimumSoc: reading(100),
        soc: reading(45, 'mqtt', { measuredAt: Date.parse('2026-09-25T19:43:00+03:00') }) },
      forecast: { feasible: false, reason: 'insufficient-time', finishAt: null } }, { now: at(clock) });
    assert.equal(result.state, state, `${clock}, charging=${charging}`);
    assert.equal(result.event, event, `${clock}, charging=${charging}`);
    assert.deepEqual(result.periodRows, expectedPeriods);
    assert.equal(result.readiness, '100 % by ready-by is at risk');
    assert.equal(result.readingTime, 'Charge measured 25 Sept 2026, 19:43');
    if (phase === 'active') assert.equal(result.eventAt, null);
  }
});

test('an active period never hides unconfirmed control behind charging permission or a later period', () => {
  const item = active(), periods = [{ startAt: now - 3600_000, endAt: now + 1800_000 }, { startAt, endAt: null }];
  const control = { owned: { startAt: periods[0].startAt }, execution: { periods } };
  for (const patch of [
    ...['unconfirmed', 'uncertain', 'ownership-uncertain', 'unavailable', 'pause-unconfirmed'].map(phase => ({ phase })),
    { phase: 'active', confirmed: false },
  ]) {
    const result = view({ ...item, plan: { ...item.plan, periods }, control: { ...control, ...patch },
      values: { ...item.values, charging: reading(false) } });
    assert.equal(result.state, 'Control unavailable', JSON.stringify(patch));
    assert.equal(result.event, 'Waiting for charger confirmation');
    assert.equal(result.eventAt, null);
    assert.doesNotMatch(result.readiness, /Expected on time/);
  }
});

test('a planned gap only claims a pause after the controller confirms it', () => {
  const item = active(), periods = [{ startAt: now - 3600_000, endAt: now - 1800_000 }, { startAt, endAt: null }];
  const control = { owned: { startAt: periods[0].startAt }, execution: { periods } };
  for (const phase of ['active', 'waiting']) {
    const result = view({ ...item, plan: { ...item.plan, periods, feasible: true }, control: { ...control, phase },
      values: { ...item.values, charging: reading(false) } });
    assert.equal(result.state, 'Pause unconfirmed');
    assert.equal(result.event, 'Next period 23:00 · pause awaiting confirmation');
    assert.match(result.problem, /pause between charging periods has not been confirmed/);
    assert.equal(result.readiness, 'Readiness being checked');
  }
  for (const patch of [{ phase: 'unconfirmed' }, { phase: 'paused', confirmed: false }]) {
    const result = view({ ...item, plan: { ...item.plan, periods }, control: { ...control, owned: { startAt }, ...patch } });
    assert.equal(result.state, 'Update unconfirmed');
    assert.equal(result.event, 'Last confirmed resume 23:00');
  }
  const live = view({ ...item, plan: { ...item.plan, periods }, control: { ...control, phase: 'active' },
    values: { ...item.values, charging: reading(true), powerKw: reading(8.2) } });
  assert.equal(live.state, 'Charging'); assert.match(live.event, /^8.2 kW now/);
});

test('manual control and Charge now retain priority during an idle scheduled period', () => {
  const item = active(), periods = [{ startAt: now - 3600_000, endAt: now + 1800_000 }, { startAt, endAt: null }];
  const control = { phase: 'active', owned: { startAt: periods[0].startAt }, execution: { periods } };
  const scheduled = { ...item, plan: { ...item.plan, periods }, control, values: { ...item.values, charging: reading(false) } };
  const manual = view({ ...scheduled, control: { ...control, phase: 'yielded', manual: { kind: 'stop', reason: 'Manual Stop is active.' } } });
  assert.equal(manual.state, 'Manual control'); assert.equal(manual.event, 'Stop instruction active');
  const immediate = view({ ...scheduled, request: { ...item.request, chargeNow: true } });
  assert.equal(immediate.state, 'Charge now selected'); assert.equal(immediate.event, 'Charging requested until unplugging');
});

test('a retained paused phase cannot override native confirmation cleared during a fresh read', () => {
  const item = active(), periods = [{ startAt: now - 3600_000, endAt: now - 1800_000 }, { startAt, endAt: null }];
  const control = { phase: 'paused', owned: { startAt }, execution: { periods },
    pauseConfirmed: true, ownsInstruction: true };
  for (const flags of [{ pauseConfirmed: false }, { ownsInstruction: false }, { pauseConfirmed: false, ownsInstruction: false }]) {
    const result = view({ ...item, plan: { ...item.plan, periods, feasible: true }, control: { ...control, ...flags },
      values: { ...item.values, charging: reading(false) } });
    assert.equal(result.state, 'Pause unconfirmed');
    assert.equal(result.event, 'Next period 23:00 · pause awaiting confirmation');
    assert.equal(result.readiness, 'Readiness being checked');
  }
  const confirmed = view({ ...item, plan: { ...item.plan, periods }, control });
  assert.equal(confirmed.state, 'Paused between periods'); assert.equal(confirmed.event, 'Resumes 23:00');
});

test('a pause confirmed for an earlier gap cannot confirm the next gap', () => {
  const at = clock => Date.parse(`2026-09-26T${clock}+03:00`), currentTime = at('04:05');
  const periods = [{ startAt: at('01:00'), endAt: at('02:30') }, { startAt: at('03:30'), endAt: at('04:00') },
    { startAt: at('04:20'), endAt: null }];
  const item = active(), control = { phase: 'paused', pauseConfirmed: true, ownsInstruction: true,
    execution: { planId: 'accepted', periods } };
  const planned = { ...item, plan: { id: 'accepted', periods, deadlineAt: at('06:00'), finishAt: at('05:00'), feasible: true } };
  for (const owned of [{ startAt: at('03:30') }, null]) {
    const result = chargerDisplay({ ...planned, control: { ...control, owned } }, { now: currentTime });
    assert.equal(result.state, 'Pause unconfirmed');
    assert.equal(result.event, 'Next period 04:20 · pause awaiting confirmation');
    assert.equal(result.readiness, 'Readiness being checked');
  }
  const current = chargerDisplay({ ...planned, control: { ...control, owned: { startAt: at('04:20') } } }, { now: currentTime });
  assert.equal(current.state, 'Paused between periods'); assert.equal(current.event, 'Resumes 04:20');
});

test('a confirmed revised plan does not appear pending because execution retains completed periods', () => {
  const item = active(), completed = { startAt: now - 2 * 3600_000, endAt: now - 3600_000 }, future = { startAt, endAt: null };
  const result = view({ ...item, plan: { ...item.plan, id: 'accepted-revision', periods: [future], costCents: 90 },
    control: { phase: 'paused', owned: { startAt }, execution: { planId: 'accepted-revision', periods: [completed, future] } } });
  assert.equal(result.event, 'Resumes 23:00'); assert.equal(result.periodRows.length, 2);
  assert.equal(Object.fromEntries(result.rows)['Estimated cost to target'], '€0.90');
  const pending = view({ ...item, plan: { ...item.plan, id: 'new-proposal', periods: [future] },
    control: { phase: 'paused', owned: { startAt }, execution: { planId: 'previous-plan', periods: [completed, future] } } });
  assert.match(pending.event, /update awaiting confirmation/);
});

test('a failed proposal keeps the last confirmed periods visible beside its specific problem', () => {
  const item = active(), confirmed = [{ startAt, endAt: startAt + 1800_000 }, { startAt: startAt + 3600_000, endAt: null }];
  const result = view({ ...item, plan: { ...item.plan, startAt: startAt + 900_000, periods: [{ startAt: startAt + 900_000, endAt: null }] },
    control: { phase: 'unavailable', errorCode: 'readback-failed', reason: 'Easee did not confirm the update. The last confirmed start may remain active; another reading will be requested.', owned: { startAt, periods: confirmed } } });
  assert.equal(result.event, 'Last confirmed start 23:00'); assert.equal(result.state, 'Update unconfirmed');
  assert.equal(result.periodRows.length, 2); assert.equal(result.periodCount, '2 charging periods');
  assert.match(result.problem, /did not confirm.*last confirmed start.*another reading/);
});

test('a schedule acknowledgement does not claim a pause when telemetry still shows charging', () => {
  const item = active(), result = view({ ...item, values: { ...item.values, charging: reading(true), powerKw: reading(8.2) },
    control: { phase: 'pause-unconfirmed', reason: 'The new start is confirmed, but charging has not paused yet. Another reading will be requested.' } });
  assert.equal(result.state, 'Charging'); assert.equal(result.event, '8.2 kW now · pause awaiting confirmation');
  assert.match(result.problem, /has not paused/);
});

test('a missed completed pause remains explained without replacing current instruction or connection error', () => {
  const item = active(), control = { phase: 'unavailable', errorCode: 'read-failed', reason: 'Easee could not be read. Another reading will be requested.',
    owned: { startAt }, lastMissedTransition: { pauseAt: now - 2 * 3600_000, resumeAt: now - 3600_000, noticedAt: now } };
  const result = view({ ...item, control });
  assert.equal(result.event, 'Last confirmed start 23:00'); assert.match(result.problem, /Easee could not be read/);
  assert.deepEqual(result.notes, ['Planned pause 19:00–20:00 was not confirmed; charging may have continued.']);
  const disconnected = view({ ...item, control, values: { ...item.values, connected: reading(false) } });
  assert.equal(disconnected.notes.length, 0);
  const off = view({ ...item, control, settings: { ...item.settings, enabled: false } });
  assert.equal(off.notes.length, 0);
});

test('manual resumption shows the earlier of the window end and cycle boundary, with the noticed date in details', () => {
  const item = active(), result = view({ ...item, control: { phase: 'yielded', manual: { kind: 'window', startsAt: startAt,
    windowEndAt: deadlineAt + 2 * 3600_000, resumeAt: deadlineAt, cycleEndsAt: deadlineAt, detectedAt: now } } });
  assert.equal(result.event, 'Manual window 23:00–tomorrow 08:00');
  assert.equal(result.priority, 'Automatic control resumes tomorrow 06:00 at the ready-by boundary.');
  assert.equal(Object.fromEntries(result.rows)['Manual change noticed'], '15 Sept 2026, 21:00');
  assert.equal(result.periodRows.length, 0); assert.equal(result.deadline, '');
  const expired = view({ ...item, control: { phase: 'yielded', errorCode: 'read-failed', reason: 'Easee is unavailable. Handover awaits a fresh reading.',
    manual: { kind: 'window', startsAt: now - 7200_000, windowEndAt: now - 3600_000, resumeAt: now - 3600_000 } } });
  assert.equal(expired.state, 'Handover pending');
  assert.equal(expired.priority, 'Manual priority expired; automatic handover awaiting confirmation.');
  assert.match(expired.problem, /Handover awaits/);
});

test('delivered energy raises estimated charge while retaining the original vehicle reading and timestamp', () => {
  const item = active(), measuredAt = now - 86400_000;
  const result = view({ ...item, values: { ...item.values, soc: reading(20, 'mqtt', { measuredAt }) },
    progress: { deliveredGridKwh: 12, remainingGridKwh: 20.888, estimatedSoc: 34.59, hasEnergyEstimate: true, estimatedSocSource: 'vehicle' } });
  assert.equal(result.soc, '≈35 %'); assert.equal(result.gridEnergy, '≈20.9 kWh'); assert.equal(result.energyLabel, 'Grid remaining');
  assert.match(result.readingTime, /14 Sept 2026/);
  assert.equal(Object.fromEntries(result.rows)['Delivered since charge reference'], '12 kWh from the grid');
  assert.equal(Object.fromEntries(result.rows)['Last reported charge'], '20 % · Vehicle MQTT · measured 14 Sept 2026, 21:00');
  assert.equal(result.sources, 'Estimated from vehicle charge and measured energy');
});

test('vehicle-feed outage shows the retained connection estimate instead of the saved starting-charge default', () => {
  const item = active(), measuredAt = now - 3600_000;
  const result = view({ ...item, values: { ...item.values, soc: reading(90, 'manual-fallback') },
    progress: { deliveredGridKwh: 0, remainingGridKwh: 30, estimatedSoc: 40, hasEnergyEstimate: false,
      retainedVehicleReference: true, referenceSoc: { value: 40, source: 'bmw-cardata', measuredAt } } });
  assert.equal(result.soc, '≈40 %');
  assert.equal(result.socSource, 'Estimated from last known vehicle charge');
  assert.equal(Object.fromEntries(result.rows)['Last reported charge'], '40 % · BMW CarData · measured 15 Sept 2026, 20:00');
  assert.equal(Object.fromEntries(result.rows)['Manual charge reference'], undefined);
  assert.ok(result.notes.some(note => /Vehicle readings are unavailable.*Edit Current charge/.test(note)));
});

test('last reported charge preserves the source and original time beside the current estimate', () => {
  const item = active(), measuredAt = now - 3600_000;
  for (const [id, label, source] of [['bmw', 'BMW', 'bmw-cardata'], ['tesla', 'Tesla', 'teslamate']]) {
    const result = view({ ...item, vehicle: { state: 'identified', id, label, source },
      values: { ...item.values, soc: reading(85, 'mqtt', { measuredAt, receivedAt: now }), minimumSoc: reading(95, source) },
      progress: { deliveredGridKwh: 3.5, remainingGridKwh: 5, estimatedSoc: 89, hasEnergyEstimate: true } });
    assert.equal(result.soc, '≈89 %'); assert.equal(result.minimum, '95 %');
    const row = result.rows.find(([name]) => name === 'Last reported charge');
    assert.equal(row[1], `85 % · ${id === 'bmw' ? 'BMW CarData' : 'TeslaMate'} · measured 15 Sept 2026, 20:00`);
    assert.match(row[2], /main charge estimate adds measured energy.*not necessarily the session’s starting charge/);
    assert.doesNotMatch(JSON.stringify(result.rows), /Vehicle charge reading|Vehicle MQTT/);
  }
  const received = view({ ...item, values: { ...item.values, soc: reading(85, 'teslamate', { receivedAt: now }) },
    progress: { estimatedSoc: 89, hasEnergyEstimate: true } });
  assert.match(Object.fromEntries(received.rows)['Last reported charge'], /received 15 Sept 2026, 21:00 · measurement time unknown$/);
  const manual = view({ ...item, values: { ...item.values, soc: reading(30, 'manual-fallback') },
    progress: { estimatedSoc: 39, hasEnergyEstimate: true } });
  assert.equal(manual.soc, '≈39 %'); assert.equal(Object.fromEntries(manual.rows)['Configured starting charge'], '30 %');
  assert.equal(manual.rows.some(([name]) => name === 'Last reported charge'), false);
});

test('live allowance is distinct from the configured ceiling and measured draw, including valid zero', () => {
  const item = active(), result = view({ ...item, capabilities: { ...item.capabilities, externalLoadBalancing: true }, values: { ...item.values,
    currentA: reading(0), maximumCurrentA: reading(16), availableCurrentA: reading(16, 'easee-equalizer', { measuredAt: now - 5 * 60_000 }), actualCurrentA: reading(0) } });
  assert.equal(Object.fromEntries(result.rows)['Charging limit'], '16 A per phase');
  assert.equal(Object.fromEntries(result.rows)['Last reported Equalizer allowance'], '16 A per phase · 20:55');
  assert(!result.rows.some(([label]) => label === 'Drawing now'));
  const zero = view({ ...item, capabilities: { ...item.capabilities, externalLoadBalancing: true }, values: { ...item.values, maximumCurrentA: reading(16), availableCurrentA: reading(0) } });
  assert.match(Object.fromEntries(zero.rows)['Last reported Equalizer allowance'], /^0 A per phase/);
  const drawing = view({ ...item, capabilities: { ...item.capabilities, externalLoadBalancing: true }, values: { ...item.values,
    charging: reading(true), actualCurrentA: reading(16), maximumCurrentA: reading(16), availableCurrentA: reading(22) } });
  assert.deepEqual(drawing.rows.slice(0, 3).map(([label]) => label), ['Drawing now', 'Last reported Equalizer allowance', 'Charging limit']);
});

test('current readiness replaces an obsolete risk without mixing different completion forecasts', () => {
  const item = active(), warnings = ['Predicted charging capacity cannot deliver this minimum by its ready by time.'];
  const recovered = view({ ...item, plan: { ...item.plan, feasible: false, reason: 'insufficient-time', warnings },
    forecast: { feasible: true, finishAt: deadlineAt - 3600_000 },
    control: { phase: 'released' }, values: { ...item.values, charging: reading(true), powerKw: reading(11) } });
  assert.equal(recovered.risk, false); assert.equal(recovered.readiness, 'Expected on time');
  assert.equal(recovered.event, '11 kW now · 80 % estimated tomorrow 05:00');
  assert(!recovered.notes.some(note => /cannot deliver/.test(note)));
  const insufficient = view({ ...item, forecast: { feasible: false, reason: 'insufficient-time', finishAt: null },
    values: { ...item.values, charging: reading(true), powerKw: reading(3) } });
  assert.equal(insufficient.risk, true); assert.equal(insufficient.readiness, '80 % by ready-by is at risk');
  assert.equal(insufficient.event, '3 kW now', 'An unavailable current finish must not fall back to the old plan finish');
  const preparing = view({ ...item, plan: { ...item.plan, feasible: false, reason: 'insufficient-time', warnings },
    forecast: { feasible: null, finishAt: null, reason: 'household-history-loading',
      warnings: ['Household history is being prepared. Charging is allowed until the forecast is ready.'] },
    control: { phase: 'provisional' } });
  assert.equal(preparing.risk, false); assert.equal(preparing.readiness, 'Readiness being checked');
  assert(!preparing.notes.some(note => /cannot deliver/.test(note)));
  assert.match(preparing.notes.join(' '), /Household history is being prepared/);
});

test('a temporary immediate allowance is not presented as the unrestricted final period', () => {
  const item = active(), result = view({ ...item, plan: { ...item.plan, startAt: now,
    periods: [{ startAt: now, endAt: null }], provisional: true, feasible: false, reason: 'electrical-telemetry-unavailable' },
    forecast: { feasible: false, finishAt: null, reason: 'electrical-telemetry-unavailable' },
    control: { phase: 'provisional' } });
  assert.equal(result.event, 'Charging is allowed'); assert.equal(result.readiness, 'Readiness being checked');
  assert.equal(result.periodRows.length, 0); assert.equal(result.risk, false);
  assert.match(result.controlDetail, /for now.*economical periods can still be scheduled/);
});

test('an infeasible forecast quantifies the target shortfall and separates forecast power from current draw', () => {
  const item = active(), result = view({ ...item, plan: { ...item.plan, feasible: false, reason: 'insufficient-time',
    warnings: ['Predicted charging capacity cannot deliver this minimum by its ready-by time.'] },
    forecast: { feasible: false, reason: 'insufficient-time', finishAt: null, shortfallGridKwh: 4.26, powerKw: 4.14,
      warnings: ['Predicted charging capacity cannot deliver this minimum by its ready-by time.'] },
    control: { phase: 'provisional' }, values: { ...item.values, charging: reading(true), powerKw: reading(11), actualCurrentA: reading(16) } });
  assert.equal(result.event, '11 kW now');
  assert.deepEqual(result.notes, ['Forecast is 4.3 kWh short of the 80 % target by tomorrow 06:00.']);
  assert.equal(Object.fromEntries(result.rows)['Drawing now'], '16 A per phase');
  assert.equal(Object.fromEntries(result.rows)['Forecast charging power'], '4.1 kW average during planned periods');
  const loading = view({ ...item, forecast: { feasible: null, shortfallGridKwh: 4.26, powerKw: 4.14 } });
  assert(!loading.rows.some(([label]) => label === 'Forecast charging power'));
});

test('current allocation explains the effective budget, lower-bound evidence and live fallback', () => {
  const item = active(); item.capabilities.externalLoadBalancing = true;
  const text = supply => Object.fromEntries(chargerDisplay(item, { now, assumptions: { supply } }).explanations)['Current allocation'];
  assert.match(text('observed-budget'), /infers available supply.*expected household use/);
  assert.match(text('observed-lower-bound'), /lower bound.*actual headroom may be higher/);
  assert.match(text('equalizer-live'), /last reported Equalizer allowance without subtracting household use again/);
});

test('only a known scheduled peer affecting this deadline appears as competing charging', () => {
  const item = active(), result = chargerDisplay(item, { now, assumptions: { competingLoads: [
    { chargerId: 'charger2', label: 'Charger 2', known: true, startAt, endAt: startAt + 3600_000, powerKw: 11 },
    { chargerId: 'unresolved', label: 'Unresolved', known: false, startAt, endAt: deadlineAt, powerKw: 11 },
    { chargerId: 'late', label: 'Later', known: true, startAt: deadlineAt + 3600_000, endAt: deadlineAt + 7200_000, powerKw: 11 },
    { chargerId: 'charger1', label: 'Charger 1', known: true, startAt, endAt: deadlineAt, powerKw: 11 },
  ] } });
  assert.deepEqual(result.rows.filter(([label]) => label === 'Other scheduled charging'), [
    ['Other scheduled charging', 'Charger 2 · starts 23:00 · 11 kW until about tomorrow 00:00'],
  ]);
});

test('estimated current charge progresses beyond the requested target and identifies missing energy coverage', () => {
  const item = active(), result = view({ ...item, progress: { estimatedSoc: 91, hasEnergyEstimate: true,
    estimatedSocSource: 'starting-charge', deliveredGridKwh: 58.4, remainingGridKwh: 0,
    basis: { energyCoverageIncomplete: true } }, values: { ...item.values, charging: reading(true), powerKw: reading(8) } });
  assert.equal(result.soc, '≈91 %'); assert.equal(result.minimum, '80 %'); assert.equal(result.gridEnergy, '0 kWh');
  assert.equal(result.sources, 'Estimated from configured starting charge and measured energy');
  assert.equal(result.minimumSource, 'Requested target');
  assert.equal(result.readiness, 'Target reached'); assert.match(result.event, /target reached$/);
  assert.match(result.notes.join(' '), /Some charging energy was not measured/);
  assert(!result.sources.includes('fallback'));
});

test('the history explanation shows a modest early estimate and preserves the value of older seasonal references', () => {
  const item = active();
  const limited = chargerDisplay(item, { now, assumptions: { householdReference: { nights: 2, limited: true,
    oldestAt: now - 240 * 86400_000, temperatureRangeC: [-22, -17], unknownCharger2: true } } });
  const text = Object.fromEntries(limited.explanations)['Current reference'];
  assert.match(text, /2 comparable nights · early estimate · -22 to -17 °C/);
  assert.match(text, /older seasonal readings/); assert.match(text, /may include unmeasured charging/);
  const zero = chargerDisplay(item, { now, assumptions: { householdReference: { nights: 0, noHistory: true } } });
  assert.match(Object.fromEntries(zero.explanations)['Current reference'], /No usable household reference.*zero other household load/);
});

test('preparing or unavailable history is not described as evidence for zero household consumption', () => {
  const explain = householdReference => Object.fromEntries(chargerDisplay(active(), { now,
    assumptions: { householdReference } }).explanations)['Current reference'];
  assert.match(explain({ loading: true, noHistory: false }), /Preparing household history.*charging is allowed/);
  assert.match(explain({ unavailable: true, noHistory: false }), /could not be prepared.*preparation retries/);
  assert.doesNotMatch(explain({ loading: true, noHistory: false }), /zero/);
  assert.match(explain({ nights: 8, loading: true }), /8 comparable nights.*refreshing/);
  assert.match(explain({ nights: 8, unavailable: true }), /8 comparable nights.*last reference retained/);
});

test('the explanation fold discloses operational assumptions without exposing irrelevant integration data', () => {
  const item = active(), result = view({ ...item, configuration: { efficiency: .9 }, capabilities: { ...item.capabilities, externalLoadBalancing: true } });
  const explanations = Object.fromEntries(result.explanations);
  assert.match(explanations['Energy estimate'], /Three-phase.*loss is fixed at 7\.5 % of grid energy \(92\.5 % reaches the battery\)/);
  assert.doesNotMatch(explanations['Energy estimate'], /90 %/);
  assert.match(explanations['Household forecast'], /older cold-weather readings remain useful/);
  assert.match(explanations['Current reference'], /details are not available yet/);
  assert.match(explanations['Current allocation'], /Equalizer controls/);
  assert.match(explanations['Period transitions'], /application and the Easee cloud/);
  assert.match(explanations['Pause recovery'], /one-off start.*scheduled time.*loses contact/);
  assert.match(explanations['Price planning'], /New prices can pause automatic charging.*costs less/);
  assert.match(explanations['Price planning'], /reaching the target or ready-by time does not stop charging/i);
  assert.match(explanations['Manual priority'], /confirmed end.*automatic scheduling when it ends/);
  assert.match(explanations['Automatic charging'], /unplugging and restart.*without replacing other charger instructions/);
  assert.match(explanations['Charge now'], /until you turn it off or unplug/);
  for (const backend of [{ control: { kind: 'ocpp-tx-pause', snapshot: null } },
    { telemetry: { transport: 'ocpp' } }, { control: { snapshot: { transport: 'ocpp' } } }]) {
    const local = Object.fromEntries(view({ ...item, ...backend }).explanations);
    assert.match(local['Period transitions'], /local charger connection.*expiring zero-current restriction/);
    assert.doesNotMatch(local['Period transitions'], /Easee cloud|one-off start/);
    assert.match(local['Pause recovery'], /expires automatically.*loses contact.*authorization.*does not return.*cloud control/);
    assert.match(local['Use automatic'], /button in Charging controls replaces.*enables Automatic charging and ends Charge now/);
    assert.match(local['Charger confirmation'], /pending until the charger confirms.*measurements.*started or paused/);
  }
  assert(!JSON.stringify(result).includes('ST-MQ'));
  assert(Object.fromEntries(view(charger('charger2')).explanations)['Period transitions']);
});

test('historical replicas describe the recorded energy assumption without rewriting primary losses', () => {
  const energy = item => Object.fromEntries(view(item).explanations)['Energy estimate'];
  const historical = { ...active(), readOnly: true, recorded: true, configuration: { efficiency: .9 } };
  assert.match(energy(historical), /recorded snapshot assumed 10 % charging loss \(90 % efficiency\).*shown as recorded, without recalculation/);
  assert.doesNotMatch(energy(historical), /fixed at 7\.5 %/);
  assert.match(energy({ ...historical, configuration: { efficiency: .925 } }), /recorded snapshot assumed 7\.5 % charging loss/);
  for (const efficiency of [undefined, null, 0, -1, 2, '0.9'])
    assert.match(energy({ ...historical, configuration: { efficiency } }), /original charging-loss assumption is unavailable/);
  for (const flags of [{ readOnly: false }, { recorded: false }]) {
    assert.match(energy({ ...historical, ...flags }), /fixed at 7\.5 %/);
    assert.doesNotMatch(energy({ ...historical, ...flags }), /90 %/);
  }
});

test('physical Charger 2 explanations preserve native vehicle constraints and distinguish instructions from effects',()=>{
  const details=Object.fromEntries(view(charger('charger2')).explanations);
  assert.match(details['Price planning'],/economical charging periods.*at least 15 minutes/);
  assert.doesNotMatch(details['Price planning'],/New prices can pause/);
  assert.match(details['Period transitions'],/several charging periods.*pause and restart.*MQTT.*confirmed charger instructions.*Actual charging activity/);
  assert.match(details['Pause recovery'],/do not expire.*loses contact with Shelly.*remain paused.*resume it in Shelly/);
  assert.match(details['Use automatic'],/button in Charging controls replaces.*automatic scheduling.*schedules stay disabled/);
  assert.match(details['Charger confirmation'],/pending until the charger confirms.*measurements.*started or paused/);
  assert.match(details['Automatic charging'],/Turning it off stops price scheduling.*limiter can remain active.*pause charging/);
  assert.match(details['Unavailable data'],/unknown charging current uses the charger’s maximum within forecast shared property capacity/);
  assert.match(details['Unavailable data'],/live current limiter retains its own configured fallback and native restrictions/);
  assert.match(details['Charging current'],/adjusts Shelly’s current.*pauses.*below the charging minimum/);
  assert.match(details['Other charging'],/automatic scheduling off/);
  assert.match(details['Target & completion'],/does not change the vehicle’s own charge limit/);
  assert.doesNotMatch(details['Period transitions'],/Easee/);
  const withoutLimiter = Object.fromEntries(view(charger('charger2', { capabilities: { scheduling: true, currentControl: false } })).explanations);
  assert.match(withoutLimiter['Automatic charging'], /charger’s own current limits and schedules remain in effect/);
  assert.doesNotMatch(withoutLimiter['Automatic charging'], /limiter can remain active/);
  assert.match(withoutLimiter['Charging current'], /identification can temporarily use the verified minimum current.*separately from the optional household current limiter.*restored afterward/);
  assert.doesNotMatch(withoutLimiter['Charging current'], /This page does not change charging current/);
  assert.doesNotMatch(withoutLimiter['Charging current'], /adjusts Shelly’s current/);
});

test('known charger limits stay available in details while the vehicle is disconnected', () => {
  const item = charger(), disconnected = view({ ...item, capabilities: { ...item.capabilities, externalLoadBalancing: true },
    values: { ...item.values, connected: reading(false), maximumCurrentA: reading(16, 'easee'), availableCurrentA: reading(0, 'easee') } });
  assert.equal(disconnected.showMetrics, false);
  assert.equal(Object.fromEntries(disconnected.rows)['Charging limit'], '16 A per phase');
  assert.equal(Object.fromEntries(disconnected.rows)['Last reported Equalizer allowance'], '0 A per phase');
});

test('both folded cards show configuration defaults without presenting stale session values as current', () => {
  const document = documentFixture(), $ = id => document.getElementById(id);
  const panel = createChargingPanel({ document, request: async () => { throw new Error('No command expected'); } });
  const items = ['charger1', 'charger2'].map(id => ({ ...charger(id),
    defaults: { readyBy: '07:15', manualSoc: 25, minimumSoc: 75, capacityKwh: 64 },
    settings: { enabled: true, readyBy: '09:55', manualSoc: 99, minimumSoc: 95, capacityKwh: 33 },
    values: { connected: reading(null), soc: reading(87), minimumSoc: reading(95) },
    progress: { estimatedSoc: 99, hasEnergyEstimate: true, remainingGridKwh: 7 },
    sessionCost: { recordedGridKwh: 12, totalCents: 345 },
  }));
  for (const connection of [null, false]) {
    panel.update(status(...items.map(item => ({ ...item, values: { ...item.values, connected: reading(connection) } }))));
    for (const item of items) {
      const id = item.id, card = $(`${id}-device`), summary = $(`${id}-device-summary`);
      assert.equal(Boolean(card.open), false);
      assert.equal($(`${id}-soc`).textContent, '25 %');
      assert.equal($(`${id}-minimum`).textContent, '75 %');
      assert.equal($(`${id}-charge-label`).textContent, 'Starting charge');
      assert.equal($(`${id}-sources`).textContent, 'Configured defaults');
      assert.equal($(`${id}-completion-label`).textContent, 'Capacity');
      assert.equal($(`${id}-completion`).textContent, '64 kWh');
      assert.equal($(`${id}-deadline`).textContent, '07:15');
      assert.equal($(`${id}-deadline`).parentElement.children[0].textContent, 'Default ready-by');
      assert.equal($(`${id}-deadline`).parentElement.hidden, false);
      for (const metric of ['soc', 'minimum', 'completion', 'deadline']) assert(summary.contains($(`${id}-${metric}`)));
      assert.equal($(`${id}-event-value`).textContent, connection === false ? 'Not connected' : 'Connection unknown');
      assert.equal($(`${id}-energy`).textContent, '—');
      assert.equal($(`${id}-delivered`).textContent, '—');
      assert.equal($(`${id}-cost`).textContent, 'No estimate');
      assert.equal($(`${id}-charge-now`).disabled, true);
      assert.equal($(`${id}-setting-manualSoc`).disabled, true);
      assert.match(openDetail($(`${id}-charge-label`)).textContent, /Configured starting charge.*Current vehicle charge is unknown/);
      document.dispatch('keydown', { key: 'Escape' });
    }
  }
  panel.update(status(...items.map(item => ({ ...item, progress: null,
    values: { connected: reading(true), soc: reading(30, 'manual-fallback'), minimumSoc: reading(70, 'manual-fallback') } }))));
  for (const { id } of items) {
    assert.equal($(`${id}-soc`).textContent, '30 %');
    assert.equal($(`${id}-minimum`).textContent, '70 %');
    assert.equal($(`${id}-charge-label`).textContent, 'Charge');
    assert.equal($(`${id}-completion-label`).textContent, 'Est. target');
    assert.equal($(`${id}-deadline`).parentElement.children[0].textContent, 'Ready by');
    assert.equal($(`${id}-charge-now`).disabled, false);
  }
  panel.close();
});

class Events {
  constructor() { this.listeners = new Map(); this.handlers = new Map(); }
  addEventListener(key, listener) {
    if (!this.handlers.has(key)) {
      this.handlers.set(key, new Set());
      this.listeners.set(key, (...args) => {
        let result; for (const action of this.handlers.get(key) ?? []) result = action(...args); return result;
      });
    }
    this.handlers.get(key).add(listener);
  }
  removeEventListener(key, listener) {
    this.handlers.get(key)?.delete(listener);
    if (!this.handlers.get(key)?.size) { this.handlers.delete(key); this.listeners.delete(key); }
  }
  dispatch(type, options = {}) {
    const event = { target: this, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...options };
    this.listeners.get(type)?.(event); return event;
  }
  dispatchEvent(event) { this.listeners.get(event.type)?.(event); return !event.defaultPrevented; }
}
class Node extends Events {
  constructor(document, tag = 'div') {
    super();
    Object.assign(this, { document, ownerDocument: document, tagName: tag.toUpperCase(), children: [], attributes: new Map(),
      value: '', disabled: false, hidden: false, dataset: {}, style: {}, className: '', ownText: '', scrollTop: 0, parentElement: null });
    this.classList = { add: (...values) => this.classes(values, []), remove: (...values) => this.classes([], values),
      toggle: (value, force) => { const enabled = force ?? !this.className.split(' ').includes(value); this.classes(enabled ? [value] : [], enabled ? [] : [value]); return enabled; } };
  }
  classes(add, remove) { this.className = [...new Set([...this.className.split(' ').filter(value => value && !remove.includes(value)), ...add])].join(' '); }
  set id(value) { this._id = value; this.document.nodes.set(value, this); }
  get id() { return this._id; }
  get parentNode() { return this.parentElement; }
  get isConnected() { return this === this.document.body || Boolean(this.parentElement?.isConnected); }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this.ownText = String(value); }
  append(...nodes) {
    for (const node of nodes) {
      if (node.tagName === '#DOCUMENT-FRAGMENT') { this.append(...node.children); continue; }
      node.remove(); node.parentElement = this; this.children.push(node);
    }
  }
  insertBefore(node, reference) {
    if (node === reference) return node;
    if (reference == null) { this.append(node); return node; }
    assert.equal(reference.parentElement, this);
    node.remove(); node.parentElement = this; this.children.splice(this.children.indexOf(reference), 0, node); return node;
  }
  replaceChildren(...nodes) { for (const child of this.children) child.parentElement = null; this.children = []; this.ownText = ''; this.append(...nodes); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  removeAttribute(key) { this.attributes.delete(key); }
  contains(target) { return target === this || this.children.some(child => child.contains(target)); }
  matches(selector) {
    if (selector === ':popover-open') return this.popoverOpen === true;
    if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    return this.tagName === selector.toUpperCase();
  }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const result = child.querySelector(selector); if (result) return result;
    }
    return null;
  }
  focus() { if (!this.disabled) this.document.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch('close'); }
  showPopover() { this.popoverOpen = true; this.showCount = (this.showCount ?? 0) + 1; }
  hidePopover() { this.popoverOpen = false; this.dispatch('toggle', { newState: 'closed' }); }
  getBoundingClientRect() {
    const left = Number.parseFloat(this.style.left) || 30, top = Number.parseFloat(this.style.top) || 80;
    const width = Number.parseFloat(this.style.width) || 80, height = this.id === 'status-detail-popover' ? 200 : 24;
    return { left, top, width, height, right: left + width, bottom: top + height };
  }
  reportValidity() { return true; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; }
}
function documentFixture() {
  const document = new Events(), frames = [];
  Object.assign(document, { nodes: new Map(), createElement: tag => new Node(document, tag), createDocumentFragment: () => new Node(document, '#document-fragment'),
    getElementById(id) { const node = this.nodes.get(id); return node?.isConnected ? node : null; },
    flushFrames() { while (frames.length) frames.shift()(); }, documentElement: { clientWidth: 390, clientHeight: 640 } });
  document.defaultView = Object.assign(new Events(), { Event, innerWidth: 390, innerHeight: 640, requestAnimationFrame: callback => frames.push(callback) });
  document.body = document.createElement('body');
  const html = readFileSync(new URL('../chart/index.html', import.meta.url), 'utf8');
  for (const match of html.matchAll(/id="((?:charging|charger)[^"]+)"/g)) { const node = document.createElement(); node.id = match[1]; document.body.append(node); }
  return document;
}
const submit = node => node.listeners.get('submit')({ preventDefault() {} });
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
function openDetail(root) {
  const trigger = root.querySelector('.status-detail-trigger');
  assert(trigger, 'The concise label opens its full explanation');
  assert.equal(trigger.tagName, 'BUTTON'); assert.equal(trigger.type, 'button');
  trigger.dispatch('click');
  const popup = root.ownerDocument.getElementById('status-detail-popover');
  assert.equal(popup.hidden, false); assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  return popup;
}

test('identical forms adapt to capabilities and automatic values, with no shared or connection setup', () => {
  const document = documentFixture(), panel = createChargingPanel({ document, request: async () => {} }), $ = id => document.getElementById(id);
  const two = connected('charger2'); panel.update(status(connected(), { ...two, values: { ...two.values, minimumSoc: reading(85), soc: reading(62) } }));
  assert.equal($('charger1-setting-minimumSoc').value, 80); assert(!$('charger1-setting-minimumSoc').disabled);
  assert(!$('charger1-setting-readyBy').disabled); assert(!$('charger2-setting-readyBy').disabled);
  const visibleFields = id => descendants($(`${id}-settings-form`))
    .filter(node => node.tagName === 'INPUT' && !node.parentElement.hidden).map(node => node.id);
  assert.equal(visibleFields('charger1')[0], 'charger1-setting-readyBy');
  assert(!$('charger1-setting-readyBy').parentElement.hidden);
  assert(!$('charger2-setting-readyBy').parentElement.hidden);
  assert.equal(visibleFields('charger2')[0], 'charger2-setting-readyBy');
  assert.equal($('charger2-setting-minimumSoc').value, 85); assert(!$('charger2-setting-minimumSoc').disabled);
  assert.equal($('charger2-setting-manualSoc').value, 62); assert(!$('charger2-setting-manualSoc').disabled);
  assert.match($('charger2-setting-minimumSoc-help').textContent, /Configured default: 80 %/);
  assert.match($('charger2-setting-manualSoc-help').textContent, /Configured default: 20 %/);
  for (const id of ['charger1', 'charger2']) for (const { key } of chargingFields) {
    const help = $(`${id}-setting-${key}-help`);
    assert(!help.querySelector('button'), 'Settings instructions remain inline beside their fields');
    assert.equal($(`${id}-setting-${key}`).getAttribute('aria-describedby'), help.id);
  }
  assert(!$('charger2-setting-capacityKwh').disabled); assert.equal($('charger2-enabled').tagName, 'BUTTON');
  assert.equal($('charger1-setting-manualSoc').value, 20);
  const original = $('charger2-device'); panel.update(status(connected(), connected('charger2'))); assert.equal($('charger2-device'), original);
  assert.equal($('charger2-setting-manualSoc').value, 20); assert(!$('charger2-setting-manualSoc').disabled);
  panel.update({ ...status(connected(), connected('charger2')), role: 'slave' }); assert($('charger1-charge-now').disabled); assert($('charger2-setting-manualSoc').disabled);
  assert(![...document.nodes.keys()].some(id => /installation|mqtt|efficiency|soc-form|soc-automatic/.test(id)));
  panel.close(); assert(!$('charger1-enabled').listeners.has('click'));
});

test('refresh preserves a fallback edit and serializes mutations', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = []; let resolve;
  const panel = createChargingPanel({ document, request: async (path, payload) => { calls.push([path, payload]); return new Promise(done => { resolve = done; }); } });
  panel.update(status(connected(), connected('charger2'))); const device = $('charger1-device'), field = $('charger1-setting-manualSoc');
  device.open = true; field.focus(); field.value = '45'; field.listeners.get('input')();
  panel.update(status(connected(), connected('charger2'))); assert.equal(device.open, true); assert.equal(field.value, '45'); assert.equal(document.activeElement, field);
  device.open = false; panel.update(status(connected(), connected('charger2'))); assert.equal(device.open, false);
  device.open = true; assert.equal($('charger1-setting-manualSoc'), field); assert.equal(field.value, '45');
  const pending = submit($('charger1-settings-form'));
  assert.deepEqual(calls, [['/api/charging/chargers/charger1/settings', sessionPayload('charger1', { manualSoc: 45 })]]);
  assert($('charger1-charge-now').disabled); await $('charger1-charge-now').listeners.get('click')({ preventDefault() {}, stopPropagation() {} }); assert.equal(calls.length, 1);
  const updated = status(connected(), connected('charger2')); updated.charging.chargers[0].settings.manualSoc = 45; resolve(updated); await pending;
  assert.equal(field.value, 45); assert($('charger1-settings-save').disabled); panel.close();
});

test('each charger saves its own session current charge and capacity through the same settings form', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = [];
  const panel = createChargingPanel({ document, request: async (path, payload) => { calls.push([path, payload]);
    const two = connected('charger2'); return status(connected(), { ...two, settings: { ...two.settings, ...payload } }); } });
  panel.update(status(connected(), connected('charger2')));
  for (const [key, value] of [['capacityKwh', '59'], ['manualSoc', '42']]) {
    const field = $(`charger2-setting-${key}`); field.value = value; field.listeners.get('input')();
  }
  await submit($('charger2-settings-form'));
  assert.equal($('charger1-enabled').textContent, 'OFF'); assert.equal($('charger1-setting-manualSoc').value, 20);
  assert.deepEqual(calls, [['/api/charging/chargers/charger2/settings', sessionPayload('charger2', { manualSoc: 42, capacityKwh: 59 })]]);
  panel.close();
});

test('a nested read-only charging snapshot locks every mutation even without a replica role', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = [];
  const panel = createChargingPanel({ document, request: async (...args) => { calls.push(args); return status(); } });
  const snapshot = status(); snapshot.charging.readOnly = true; panel.update(snapshot);
  for (const id of ['charger1-charge-now', 'charger1-setting-manualSoc', 'charger2-setting-manualSoc', 'charger1-setting-capacityKwh',
    'charger2-setting-capacityKwh']) assert($(id).disabled, id);
  await $('charger1-charge-now').listeners.get('click')({ preventDefault() {}, stopPropagation() {} }); await submit($('charger1-settings-form'));
  assert.deepEqual(calls, []);
  assert(![...document.nodes.keys()].some(id => /-setting-.*(?:current|connected|scheduled)/i.test(id)));
  panel.close();
});

test('a planning error stays visible and clears on recovery', () => {
  const document = documentFixture(), $ = id => document.getElementById(id);
  const panel = createChargingPanel({ document, request: async () => status() });
  const failed = status(); failed.charging.error = 'charging-planning-unavailable'; panel.update(failed);
  assert(!$('charging-status').hidden); assert.equal($('charging-status').textContent, 'Charging needs attention');
  const popup = openDetail($('charging-status'));
  assert.match(popup.textContent, /charging plan could not be updated/);
  assert.match($('charging-status').querySelector('button').getAttribute('aria-label'), /last charger instructions remain in effect/);
  panel.update(status()); assert($('charging-status').hidden); assert.equal($('charging-status').textContent, '');
  assert(popup.hidden, 'Recovery dismisses the resolved planning error');
  panel.close();
});

test('a compact summary warning retains the full cause and updates its open explanation on recovery', () => {
  const document = documentFixture(), $ = id => document.getElementById(id);
  const panel = createChargingPanel({ document, request: async () => status() });
  const item = active(), reason = 'The charger did not confirm the new schedule. The previous start remains active; another reading will be requested.';
  panel.update(status({ ...item, control: { phase: 'unavailable', reason, owned: { startAt } } }));
  const notice = $('charger1-notice'), popup = openDetail(notice), trigger = notice.querySelector('button');
  assert.equal(notice.textContent, 'Charger needs attention'); assert.match(popup.textContent, /previous start remains active/);
  assert.equal($('charger1-problem').textContent, reason); assert(!$('charger1-device').open);
  panel.update(status({ ...item, control: { phase: 'waiting', owned: { startAt } }, plan: { ...item.plan, feasible: true } }));
  document.flushFrames();
  assert.equal(notice.querySelector('button'), trigger); assert.equal(popup.hidden, false);
  assert.match(notice.textContent, /Expected on time/); assert.doesNotMatch(popup.textContent, /did not confirm/);
  assert($('charger1-problem').hidden); panel.close();
});

test('live SoC updates preserve a user draft and permit an explicit session edit', async () => {
  const document=documentFixture(),$=id=>document.getElementById(id),calls=[];
  const panel=createChargingPanel({document,request:async(...args)=>{calls.push(args);return status(connected(), connected('charger2'));}});
  panel.update(status(connected(), connected('charger2')));const field=$('charger2-setting-manualSoc');field.value='75';field.dispatch('input');
  const two=connected('charger2');panel.update(status(connected(),{...two,values:{...two.values,soc:reading(85)}}));
  assert.equal(field.value,'75');assert.equal(field.disabled,false);
  await submit($('charger2-settings-form'));assert.deepEqual(calls,[['/api/charging/chargers/charger2/settings',sessionPayload('charger2', {manualSoc:75})]]);
  panel.close();
});

test('current charge fields follow vehicle readings and measured progress without saving defaults or drafts', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = [];
  const panel = createChargingPanel({ document, request: async (...args) => { calls.push(args); return status(connected()); } });
  const item = connected(), defaults = structuredClone(item.settings);
  const current = (soc, progress = {}) => ({ ...item,
    values: { ...item.values, charging: reading(true), soc: reading(soc, 'bmw-cardata', { measuredAt: now }) }, progress });
  panel.update(status(current(40)));
  const input = $('charger1-setting-manualSoc'), help = $('charger1-setting-manualSoc-help');
  assert.equal(input.parentElement.querySelector('label').textContent, 'Current charge · %');
  assert.equal(input.value, 40);
  panel.update(status(current(45)));
  assert.equal(input.value, 45);
  assert.match(help.textContent, /Latest reading from BMW CarData/);
  panel.update(status(current(45, { estimatedSoc: 49.26, hasEnergyEstimate: true })));
  assert.equal(input.value, 49.3);
  assert.match(help.textContent, /Estimated from BMW CarData reading and measured energy/);
  assert.doesNotMatch(help.textContent, /Current estimate:|49\.3|Unsaved|charging losses/);
  assert.match(help.textContent, /newer vehicle reading.*Configured default: 20 %/);
  input.focus(); input.value = '51.2'; input.dispatch('input');
  panel.update(status(current(52, { estimatedSoc: 53.1, hasEnergyEstimate: true })));
  assert.equal(document.activeElement, input); assert.equal(input.value, '51.2');
  assert.match(help.textContent, /Unsaved edit.*Current estimate: 53.1 %/);
  assert.deepEqual(item.settings, defaults); assert.deepEqual(calls, []);
  await submit($('charger1-settings-form'));
  assert.deepEqual(calls, [['/api/charging/chargers/charger1/settings', sessionPayload('charger1', { manualSoc: 51.2 })]]);
  panel.close();
});

test('current charge fields retain outage estimates, label manual progress, and reset on a new connection', () => {
  const document = documentFixture(), $ = id => document.getElementById(id);
  const panel = createChargingPanel({ document, request: async () => {} });
  const item = connected('charger2'), progress = { estimatedSoc: 44, hasEnergyEstimate: false,
    retainedVehicleReference: true, referenceSoc: { value: 44, source: 'teslamate', measuredAt: now - 3600_000 } };
  panel.update(status({ ...item, progress }));
  const input = $('charger2-setting-manualSoc'), help = $('charger2-setting-manualSoc-help');
  assert.equal(input.value, 44); assert.match(help.textContent, /Estimated from the last TeslaMate reading/);
  panel.update(status({ ...item, progress: { estimatedSoc: 35.4, hasEnergyEstimate: true } }));
  assert.equal(input.value, 35.4); assert.match(help.textContent, /configured starting charge and measured energy/);
  panel.update(status({ ...item, progress: { estimatedSoc: 70, hasEnergyEstimate: false } }));
  assert.equal(input.value, 20, 'An unsubstantiated estimate does not replace the configured charge');
  input.focus(); input.value = '48'; input.dispatch('input');
  panel.update(status({ ...item, request: { ...item.request, sessionId: 'next-connection' } }));
  assert.equal(input.value, 20); assert($('charger2-settings-save').disabled);
  panel.close();
});

test('saving another session field never submits automatically refreshed current charge', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = [];
  const item = { ...connected(), progress: { estimatedSoc: 43.2, hasEnergyEstimate: true } };
  const panel = createChargingPanel({ document, request: async (...args) => { calls.push(args); return status(item); } });
  panel.update(status(item));
  assert.equal($('charger1-setting-manualSoc').value, 43.2);
  const readyBy = $('charger1-setting-readyBy'); readyBy.value = '07:30'; readyBy.dispatch('input');
  panel.update(status({ ...item, progress: { estimatedSoc: 45.7, hasEnergyEstimate: true } }));
  assert.equal($('charger1-setting-manualSoc').value, 45.7);
  await submit($('charger1-settings-form'));
  assert.deepEqual(calls, [['/api/charging/chargers/charger1/settings', sessionPayload('charger1', { readyBy: '07:30' })]]);
  panel.close();
});

test('saved manual current charge stays a manual reference as measured energy advances it', () => {
  const document = documentFixture(), $ = id => document.getElementById(id);
  const panel = createChargingPanel({ document, request: async () => {} });
  const item = connected(), anchored = { ...item, settings: { ...item.settings, manualSoc: 35 },
    values: { ...item.values, soc: reading(35, 'session-anchor', { measuredAt: now }) } };
  panel.update(status(anchored));
  assert.equal($('charger1-setting-manualSoc').value, 35);
  assert.match($('charger1-setting-manualSoc-help').textContent, /Saved manual charge reference/);
  const advanced = { ...anchored, progress: { estimatedSoc: 42, hasEnergyEstimate: true } };
  panel.update(status(advanced));
  assert.equal($('charger1-setting-manualSoc').value, 42);
  assert.match($('charger1-setting-manualSoc-help').textContent, /manual charge and measured energy/);
  const presented = view(advanced);
  assert.equal(presented.socSource, 'Estimated from manual charge and measured energy');
  assert.equal(presented.readingTime, '', 'The edit timestamp is not a vehicle measurement');
  assert.equal(Object.fromEntries(presented.rows)['Manual charge reference'], '35 %');
  assert(!presented.rows.some(([label]) => label === 'Last reported charge'));
  panel.close();
});

test('Charger 2 popups explain manual priority and unconfirmed instructions without internal codes', () => {
  const document = documentFixture(), $ = id => document.getElementById(id);
  const panel = createChargingPanel({ document, request: async () => {} });
  const item = connected('charger2'); item.settings.enabled = true;
  for (const [reason, manual, expected] of [
    ['manual-stop', { kind: 'stop' }, /stop instruction is preventing automatic scheduling/i],
    ['native-schedule', { kind: 'schedule' }, /charger’s own schedule has priority/i],
    ['evse-command-unconfirmed', null, /outcome is still unknown.*fresh reading/i],
    ['telemetry-fallback', null, /configured fallback.*fresh measurements/i],
    ['future-control-condition', null, /Check the charger controls for details/],
  ]) {
    panel.update(status({ ...item, control: { phase: manual ? 'manual' : 'uncertain', reason, manual, confirmed: false } }));
    for (const id of ['charger2-state', 'charger2-notice']) {
      const popup = openDetail($(id)); assert.match(popup.textContent, expected);
      assert(!popup.textContent.includes(reason));
      assert(!($(id).querySelector('button').getAttribute('aria-label') ?? '').includes(reason));
    }
    assert(!($('charger2-event-value').textContent ?? '').includes(reason));
    assert(!openDetail($('charger2-event-value')).textContent.includes(reason));
    assert(!($('charger2-control-detail').textContent ?? '').includes(reason));
    assert.equal($('charger2-enabled').getAttribute('aria-checked'), 'true', 'Manual priority preserves the Automatic preference');
    assert.equal($('charger2-resume'), null);
  }
  panel.close();
});

test('both Automatic switches change only the persistent preference and preserve other charger instructions', async () => {
  for (const id of ['charger1', 'charger2']) {
    const document = documentFixture(), $ = name => document.getElementById(name), calls = [];
    let item = { ...connected(id), control: { phase: 'manual', reason: 'manual-stop', manual: { kind: 'stop' } } };
    const panel = createChargingPanel({ document, request: async (path, payload) => {
      calls.push([path, payload]);
      if (path.endsWith('/control')) item = { ...item, settings: { ...item.settings, enabled: payload.enabled },
        controls: { enabled: payload.enabled, revision: item.controls.revision + 1 } };
      return status(item);
    } });
    panel.update(status(item)); const toggle = $(`${id}-enabled`);
    assert.equal($(`${id}-resume`), null);
    await clickAction(toggle);
    assert.deepEqual(calls, [[`/api/charging/chargers/${id}/control`, { association: item.association, revision: 0, enabled: true }]]);
    assert.equal(toggle.getAttribute('aria-checked'), 'true');
    assert.equal($(`${id}-control-message`).textContent, 'Preference saved');
    assert.match($(`${id}-event-value`).textContent, /Stop instruction active/);
    assert.match($(`${id}-control-detail`).textContent, /Automatic charging remains on while another charger instruction has priority/);
    await clickAction(toggle);
    assert.deepEqual(calls.at(-1), [`/api/charging/chargers/${id}/control`, { association: item.association, revision: 1, enabled: false }]);
    assert.equal(calls.length, 2, 'Turning OFF only changes the durable automatic preference');
    assert.equal(toggle.getAttribute('aria-checked'), 'false'); panel.close();
  }
});

test('both shared Use automatic actions submit the displayed connection and native token without changing preference first', async () => {
  for (const id of ['charger1', 'charger2']) for (const enabled of [false, true]) {
    const document = documentFixture(), $ = name => document.getElementById(name), calls = []; let finish;
    const item = { ...connected(id), controls: { enabled, revision: 4 },
      control: { phase: 'manual', reason: 'native-schedule', manual: { kind: 'schedule' }, takeover: { available: true, token: 'fixture-current-native-state' } } };
    item.settings.enabled = enabled; item.request.chargeNow = true;
    const panel = createChargingPanel({ document, request: (...args) => { calls.push(args); return new Promise(resolve => { finish = resolve; }); } });
    panel.update(status(item)); const button = $(`${id}-use-automatic`);
    assert.equal(button.textContent, 'Use automatic'); assert(!button.hidden && !button.disabled);
    assert($(`${id}-charging-controls`).contains(button)); assert(!$(`${id}-device-summary`).contains(button));
    assert.match($(`${id}-takeover-help`).textContent, /enables Automatic charging.*replaces the current charger instruction.*ends Charge now/);
    assert.match($(`${id}-takeover-help`).textContent, /Charger schedules stay disabled until changed/);
    const pending = clickAction(button);
    assert(button.disabled && !button.hidden, 'Keep the selected action visible while its local request is in flight');
    assert($(`${id}-enabled`).disabled); assert.match($(`${id}-takeover-message`).textContent, /Saving/);
    await clickAction(button); assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [`/api/charging/chargers/${id}/use-automatic`, { association: item.association,
      sessionId: item.request.sessionId, revision: item.request.revision, controlRevision: 4, takeoverToken: 'fixture-current-native-state' }]);
    const acknowledged = { ...item, settings: { ...item.settings, enabled: true }, request: { ...item.request, chargeNow: false },
      control: { phase: 'waiting', takeover: { available: false, token: null, state: 'pending' } } };
    finish(status(acknowledged)); await pending;
    assert(button.disabled && button.hidden); assert.equal($(`${id}-enabled`).getAttribute('aria-checked'), 'true');
    assert.equal($(`${id}-charge-now`).getAttribute('aria-pressed'), 'false');
    assert.match($(`${id}-takeover-help`).textContent, /Waiting for charger confirmation/);
    assert.match($(`${id}-state`).textContent, /Handover pending/);
    assert.match($(`${id}-takeover-message`).textContent, /requested.*Waiting for charger confirmation/);
    assert.doesNotMatch($(`${id}-takeover-message`).textContent, /scheduling confirmed|control confirmed|Charging started|handover is complete/);
    const confirmed = { ...acknowledged, control: { phase: 'waiting', takeover: { available: true, token: 'fixture-reconciled',
      attemptToken: item.control.takeover.token, state: 'confirmed' } } };
    for (const unrelated of [
      { ...confirmed, control: { ...confirmed.control, takeover: { ...confirmed.control.takeover, attemptToken: 'fixture-another-action' } } },
      { ...confirmed, request: { ...confirmed.request, sessionId: 'another-connection' } },
      { ...confirmed, association: 'fixture:replacement-equipment' },
    ]) {
      panel.update(status(unrelated));
      assert.match($(`${id}-takeover-message`).textContent, /Waiting for charger confirmation/,
        'Confirmation must belong to this action, equipment and connection');
    }
    panel.update(status(confirmed));
    const receipt = $(`${id}-takeover-message`).textContent;
    assert.match(receipt, /Automatic scheduling confirmed/);
    assert(button.hidden && button.disabled, 'Successful takeover removes the now-irrelevant action');
    assert(!$(`${id}-takeover-message`).hidden, 'The action receipt remains visible after its button is hidden');
    panel.update(status({ ...confirmed, control: { phase: 'unavailable', reason: 'read-failed', takeover: { available: false, token: null } } }));
    assert.equal($(`${id}-takeover-message`).textContent, receipt, 'A later stale reading must not undo confirmed action evidence');
    panel.close();
  }
});

test('Use automatic availability follows capabilities, authority, session and native evidence for both providers', async () => {
  for (const id of ['charger1', 'charger2']) {
    const document = documentFixture(), $ = name => document.getElementById(name), calls = [];
    const item = { ...connected(id), control: { phase: 'manual', reason: 'manual-stop', manual: { kind: 'stop' },
      takeover: { available: true, token: 'fixture-native-state' } } };
    const panel = createChargingPanel({ document, request: async (...args) => { calls.push(args); return status(item); } });
    const ordinary = { ...item, control: { phase: 'waiting', takeover: item.control.takeover } };
    for (const enabled of [false, true]) for (const chargeNow of [false, true]) {
      panel.update(status({ ...ordinary, settings: { ...ordinary.settings, enabled }, request: { ...ordinary.request, chargeNow } }));
      assert($(`${id}-use-automatic`).hidden && $(`${id}-use-automatic`).disabled,
        'Capability readiness and Charge now alone do not make takeover relevant');
      assert($(`${id}-takeover-help`).hidden);
      await clickAction($(`${id}-use-automatic`)); assert.deepEqual(calls, []);
    }
    for (const enabled of [false, true]) {
      panel.update(status({ ...item, settings: { ...item.settings, enabled } }));
      assert(!$(`${id}-use-automatic`).hidden && !$(`${id}-use-automatic`).disabled,
        'A replaceable external instruction permits explicit takeover with either Automatic preference');
      panel.update(status({ ...item, settings: { ...item.settings, enabled }, control: { phase: 'unavailable',
        errorCode: 'charger-stopped', manual: null, takeover: item.control.takeover } }));
      assert(!$(`${id}-use-automatic`).hidden && !$(`${id}-use-automatic`).disabled,
        'A confirmed pre-existing stop permits takeover without attributing it to an observed manual change');
    }
    for (const changed of [
      { ...status(item), role: 'slave' }, { ...status(item), readOnly: true }, status({ ...item, readOnly: true }),
      { ...status(item), charging: { ...status(item).charging, readOnly: true } },
      status({ ...item, request: null }), status({ ...item, values: { ...item.values, connected: reading(false) } }),
      status({ ...item, values: { ...item.values, connected: reading(null) } }),
      status({ ...item, capabilities: { scheduling: false } }), status({ ...item, control: {} }), status({ ...item, controls: null }),
      status({ ...item, control: { ...item.control, takeover: { available: true, token: null } } }),
      status({ ...item, control: { ...item.control, takeover: { available: true, token: '' } } }),
      status({ ...item, control: { ...item.control, takeover: { available: true, token: 'pending', state: 'pending' } } }),
      status({ ...item, control: { phase: 'unavailable', errorCode: 'charger-stopped', manual: null,
        takeover: { available: false, token: null } } }),
      status({ ...item, control: { ...item.control, takeover: { available: false, token: 'stale', reason: 'Fresh charger readings are unavailable.' } } }),
    ]) {
      panel.update(changed); assert($(`${id}-use-automatic`).disabled && $(`${id}-use-automatic`).hidden);
      await clickAction($(`${id}-use-automatic`)); assert.deepEqual(calls, []);
    }
    assert.match($(`${id}-takeover-help`).textContent, /Fresh charger readings are unavailable/);
    panel.update(status(item)); assert(!$(`${id}-use-automatic`).disabled && !$(`${id}-use-automatic`).hidden);
    panel.close();
  }
});

test('Use automatic errors remain readable and keep the current preference and native state', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id);
  const item = { ...connected('charger2'), control: { phase: 'manual', reason: 'manual-stop',
    takeover: { available: true, token: 'fixture-older-native-state' } } };
  const panel = createChargingPanel({ document, request: async () => { throw new Error('The charger changed after this view was loaded. Review its latest state before trying again.'); } });
  panel.update(status(item)); await clickAction($('charger2-use-automatic'));
  assert.equal($('charger2-enabled').getAttribute('aria-checked'), 'false');
  assert($('charger2-takeover-message').matches('.form-error'));
  assert.match($('charger2-takeover-message').textContent, /charger changed.*latest state/);
  assert(!$('charger2-use-automatic').disabled);
  panel.close();
});

test('a failed Use automatic request refreshes an acknowledged preference without claiming a completed handover', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id); let refreshes = 0;
  const item = { ...connected('charger2'), control: { phase: 'manual', reason: 'native-schedule', manual: { kind: 'schedule' },
    takeover: { available: true, token: 'fixture-native-state' } } };
  const acknowledged = { ...item, settings: { ...item.settings, enabled: true },
    control: { ...item.control, takeover: { available: false, token: null, state: 'blocked', reason: 'evse-native-schedule-unconfirmed' } } };
  const panel = createChargingPanel({ document,
    request: async () => { throw new Error('evse-native-schedule-unconfirmed'); },
    afterRequest: () => { refreshes++; panel.update(status(acknowledged)); } });
  panel.update(status(item)); await clickAction($('charger2-use-automatic'));
  assert.equal(refreshes, 1, 'The production callback refreshes status after failure as well as success');
  assert.equal($('charger2-enabled').getAttribute('aria-checked'), 'true');
  assert.equal($('charger2-state').textContent, 'Handover blocked');
  assert.match($('charger2-takeover-message').textContent, /previous schedule was disabled.*has not taken over/);
  assert.match($('charger2-takeover-help').textContent, /has not taken over/);
  assert($('charger2-use-automatic').disabled);
  panel.close();
});

test('visitor settings remain editable until identification and automatic fields never replace saved defaults', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = [];
  const visitor = { ...active(), vehicle: { state: 'unidentified' } };
  const saved = { ...visitor, settings: { ...visitor.settings, manualSoc: 35, minimumSoc: 90, capacityKwh: 61 } };
  const panel = createChargingPanel({ document, request: async (...args) => { calls.push(args); return status(saved); } });
  panel.update(status(visitor));
  assert.equal($('charger1-title').textContent, 'Charger 1');
  assert.equal($('charger1-vehicle').textContent, 'Easee · Vehicle unidentified');
  for (const [key, value] of Object.entries({ manualSoc: '35', minimumSoc: '90', capacityKwh: '61' })) {
    const input = $(`charger1-setting-${key}`); assert.equal(input.disabled, false); input.value = value; input.dispatch('input');
  }
  await submit($('charger1-settings-form'));
  assert.deepEqual(calls[0], ['/api/charging/chargers/charger1/settings', sessionPayload('charger1', { manualSoc: 35, minimumSoc: 90, capacityKwh: 61 })]);
  const identifying = { ...saved, vehicle: { state: 'identifying' } };
  panel.update(status(identifying));
  assert.equal($('charger1-vehicle').textContent, 'Easee · Identifying vehicle');
  assert.equal($('charger1-setting-manualSoc').disabled, false);
  const bmw = { ...saved, vehicle: { state: 'identified', id: 'bmw', label: 'BMW', source: 'bmw-cardata' },
    values: { ...saved.values, soc: reading(57, 'bmw-cardata', { measuredAt: now }), minimumSoc: reading(83, 'bmw-cardata') } };
  panel.update(status(bmw));
  assert.equal($('charger1-vehicle').textContent, 'Easee · BMW identified');
  assert.equal($('charger1-setting-manualSoc').value, 57); assert.equal($('charger1-setting-manualSoc').disabled, false);
  assert.equal($('charger1-setting-minimumSoc').value, 83); assert.equal($('charger1-setting-minimumSoc').disabled, false);
  assert.match($('charger1-setting-manualSoc-help').textContent, /BMW CarData.*Configured default: 35 %/);
  assert.equal($('charger1-setting-capacityKwh').value, 61); assert.equal($('charger1-setting-capacityKwh').disabled, false);
  panel.update(status({ ...saved, vehicle: { state: 'disconnected' }, values: { ...saved.values, connected: reading(false) } }));
  assert.equal($('charger1-vehicle').textContent, 'Easee · Any vehicle');
  for (const [key, value] of Object.entries({ manualSoc: 35, minimumSoc: 90, capacityKwh: 61 })) {
    assert.equal($(`charger1-setting-${key}`).value, value); assert.equal($(`charger1-setting-${key}`).disabled, true);
  }
  panel.close();
});

test('held BMW target uses attention color with report details but no extra notice or controls', () => {
  const document = documentFixture(), $ = id => document.getElementById(id);
  const panel = createChargingPanel({ document, request: async () => status() });
  const item = bmwTarget(); panel.update(status(item));
  assert.equal($('charger1-minimum').textContent, '85 %');
  assert.equal($('charger1-minimum').dataset.state, 'attention');
  assert.equal($('charger1-target-source').textContent, 'Held BMW target');
  for (const name of ['notice', 'controls', 'toggle', 'help', 'message']) assert.equal($(`charger1-target-${name}`), null);
  assert.equal($('charger1-device').open, undefined, 'The held target remains visible in the collapsed summary');
  assert.match($('charger1-setting-minimumSoc-help').textContent, /^BMW target retained after conflicting reports/);
  const popup = openDetail($('charger1-target-label'));
  assert.match(popup.textContent, /Selected planning target: 85 %, measured 15 Sept 2026, 20:59/);
  assert.match(popup.textContent, /Latest BMW target report: 100 %, measured 15 Sept 2026, 21:00/);
  assert.match(popup.textContent, /change from 100% to a lower target.*holds the latest target below 100%.*ignores later 100% reports/);
  assert.match(popup.textContent, /Edit the target in Session settings and save/);
  assert.match(view(item).minimumSource, /held after conflicting reports/);
  panel.close();
});

test('normal Save replaces held BMW targets with 84% or 100% and clears stale attention and details', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = [];
  const item = bmwTarget();
  const panel = createChargingPanel({ document, request: async (path, payload) => {
    calls.push([path, payload]);
    const value = payload.changes.minimumSoc;
    return status({ ...item, settings: { ...item.settings, minimumSoc: value },
      request: { ...item.request, revision: item.request.revision + 1, overrides: { minimumSoc: value } },
      values: { ...item.values, minimumSoc: reading(value, 'session-request') } });
  } });
  for (const value of [84, 100]) {
    panel.update(status(item));
    const input = $('charger1-setting-minimumSoc');
    const popup = !$('status-detail-popover')?.hidden && $('status-detail-popover')
      || openDetail($('charger1-target-label'));
    input.value = String(value); input.dispatch('input');
    panel.update(status(item));
    assert.equal(input.value, String(value), 'A later 100% BMW report preserves the unsaved draft');
    await submit($('charger1-settings-form'));
    document.flushFrames();
    assert.deepEqual(calls.at(-1), ['/api/charging/chargers/charger1/settings', sessionPayload('charger1', { minimumSoc: value })]);
    assert.equal($('charger1-minimum').textContent, `${value} %`);
    assert.equal($('charger1-minimum').dataset.state, 'normal');
    assert.equal($('charger1-target-source').hidden, true);
    assert.match(popup.textContent, new RegExp(`Selected planning target: ${value} %`));
    assert.match(popup.textContent, /Planning target for this connection/);
    assert.doesNotMatch(popup.textContent, /Selected planning target: 85|holds the latest target|reports conflict/);
    assert.equal($('charger1-setting-minimumSoc').value, value);
    assert.equal($('charger1-settings-save').disabled, true);
  }
  panel.close();
});

test('BMW target attention clears on unplug, another vehicle and an unfiltered connection', () => {
  const document = documentFixture(), $ = id => document.getElementById(id);
  const panel = createChargingPanel({ document, request: async () => status() });
  const item = bmwTarget();
  for (const patch of [
    { vehicle: { state: 'disconnected' }, values: { ...item.values, connected: reading(false) } },
    { vehicle: { state: 'unidentified' } },
    { vehicle: { state: 'identified', id: 'tesla', label: 'Tesla' } },
    bmwTarget({ connectedAt: now, conflict: false, rawValue: 90 }),
  ]) {
    panel.update(status(item)); assert.equal($('charger1-minimum').dataset.state, 'attention');
    panel.update(status({ ...item, ...patch }));
    assert.equal($('charger1-minimum').dataset.state, 'normal');
    assert.equal($('charger1-target-source').hidden, true);
    assert.equal($('charger1-target-notice'), null);
  }
  panel.close();
});

test('BMW unknown location distinguishes indefinite remembered home context from a current location reading', () => {
  const item = connected(), measuredAt = now - 14 * 24 * 60 * 60_000;
  item.vehicle = { state: 'identifying', id: null, homeContext: { source: 'last-known', measuredAt } };
  item.identification = { phase: 'pausing', active: true, available: true };
  const pending = view(item);
  assert.match(pending.vehicle.detail, /last confirmed home location.*current location is unavailable/);
  assert.ok(pending.vehicle.detail.includes(chargingTime(measuredAt, 'Europe/Helsinki', now)));
  assert.match(pending.vehicle.detail, /Matching charging evidence is still required for this connection/);
  assert.match(pending.vehicle.label, /Identifying/);
  item.vehicle = { ...item.vehicle, state: 'identified', id: 'bmw', label: 'BMW' };
  item.identification = { phase: 'completed', active: false, available: true };
  assert.match(view(item).vehicle.detail, /current location is unavailable/);
  item.vehicle.homeContext = null;
  assert.doesNotMatch(view(item).vehicle.detail, /last confirmed home location/);
});

test('BMW awaiting-stop identification explains the pending evidence while leaving saved target editable', () => {
  const document = documentFixture(), $ = id => document.getElementById(id);
  const panel = createChargingPanel({ document, request: async () => status() });
  panel.update(status({ ...active(), vehicle: { state: 'unidentified', reason: 'awaiting-stop-confirmation' } }));
  assert.match($('charger1-vehicle').textContent, /BMW identification pending/);
  const popup = openDetail($('charger1-vehicle'));
  assert.match(popup.textContent, /matching charging-stop readings from BMW and the charger.*Configured vehicle defaults remain in use/s);
  assert.equal($('charger1-setting-minimumSoc').disabled, false);
  assert.equal($('charger1-target-controls'), null); panel.close();
});

test('active probing describes normal current and the controller energy allowance', () => {
  const item = { ...active(), vehicle: { state: 'identifying', id: null },
    identification: { phase: 'charging', active: true, available: true, probe: { endedAt: null } } };
  assert.match(view(item).vehicle.detail, /normal current settings.*0\.15 kWh energy budget.*controller ends the test/);
  assert.doesNotMatch(view(item).vehicle.detail, /minimum.current|6 A|three phases/);
});

test('minimum-current identification distinguishes a requested setting from measured Tesla evidence', () => {
  const document = documentFixture(), $ = id => document.getElementById(id);
  const panel = createChargingPanel({ document, request: async () => status() });
  const item = { ...connected('charger2'), capabilities: { scheduling: true, currentControl: false },
    vehicle: { state: 'identifying', id: null }, telemetry: { identificationCurrentReady: true },
    identification: { phase: 'waiting', active: true, available: true,
      currentTest: { phase: 'proposed', appliedCurrentA: 6, originalCurrentA: 16, expiresAt: now + 90_000 } } };
  for (const phase of ['proposed', 'applying']) {
    item.identification.currentTest.phase = phase;
    panel.update(status(item));
    assert.equal($('charger2-identification-state').textContent, 'Confirming');
    assert.match($('charger2-identification-status').textContent, /temporary 6 A.*confirmation is pending.*ends by 21:01/);
    assert.doesNotMatch($('charger2-identification-status').textContent, /charger confirmed/);
    assert($('charger2-identify').disabled);
  }
  item.identification.currentTest.phase = 'active'; item.identification.reason = 'current-ambiguous';
  panel.update(status(item));
  assert.equal($('charger2-identification-state').textContent, 'Checking');
  assert.match($('charger2-identification-status').textContent, /confirmed a temporary 6 A current limit.*fresh measured draw.*distinguish the two chargers.*readings overlap.*restored afterward/);
  assert.match($('charger2-readings').textContent, /Identification currentTemporary minimum available/);
  assert.equal(view(item).event, 'Comparing measured current');
  assert.doesNotMatch($('charger2-vehicle').textContent, /Tesla identified/);
  panel.close();
});

test('current restoration remains visible after identification and unplug until its obligation ends', () => {
  const document = documentFixture(), $ = id => document.getElementById(id);
  const panel = createChargingPanel({ document, request: async () => status() });
  const item = { ...connected('charger2'), vehicle: { state: 'identified', id: 'tesla', label: 'Tesla' },
    identification: { phase: 'completed', active: false, available: true,
      currentTest: { phase: 'restoring', appliedCurrentA: 6, originalCurrentA: 16, restoreCurrentA: 12 } } };
  for (const phase of ['restoring', 'active']) {
    item.identification.currentTest.phase = phase;
    panel.update(status(item));
    assert.equal($('charger2-identification-state').textContent, 'Recovery pending');
    assert.match($('charger2-identification-status').textContent, /awaiting restoration to 12 A.*confirmation is still required.*newer external current instructions keep priority/);
    assert($('charger2-identify').disabled);
    assert.match($('charger2-identify').title, /temporary identification settings/);
  }
  item.identification.currentTest.phase = 'uncertain'; panel.update(status(item));
  assert.equal($('charger2-identification-state').textContent, 'Review required');
  assert.match($('charger2-identification-status').textContent, /outcome.*unknown.*actual current setting.*record remains pending/);
  assert.doesNotMatch($('charger2-identification-status').textContent, /controller retries/);
  assert($('charger2-identify').disabled);
  item.identification.currentTest.phase = 'restoring';
  item.values.connected = reading(false); panel.update(status(item));
  assert.equal($('charger2-identification-state').textContent, 'Recovery pending');
  assert.equal($('charger2-identification').dataset.state, 'attention');
  item.values.connected = reading(true);
  for (const phase of ['restored', 'superseded']) {
    item.identification.currentTest.phase = phase; panel.update(status(item));
    assert.equal($('charger2-identification-state').textContent, 'Ready');
    assert.equal($('charger2-identification').dataset.state, 'normal');
    assert.equal($('charger2-identify').disabled, false);
  }
  panel.close();
});

test('pending current identification names missing readiness, observations and ambiguity separately', () => {
  const item = { ...connected('charger2'), identification: { phase: 'waiting', active: true, available: false } };
  for (const [reason, expected] of [
    ['current-control-unavailable', /current-control readiness.*optional household current limiter has separate settings/],
    ['current-evidence-pending', /fresh measured charger current.*current setting alone does not identify/],
    ['current-ambiguous', /Both chargers could match.*independent evidence/],
  ]) {
    item.identification.reason = reason;
    assert.match(view(item).identification.detail, expected);
    assert.equal(view(item).identification.state, 'Pending');
  }
});

test('finished probing shows an inconclusive attempt and keeps passive matching and ordinary charging available', () => {
  const document = documentFixture(), $ = id => document.getElementById(id);
  const panel = createChargingPanel({ document, request: async () => status() });
  const item = { ...connected(), vehicle: { state: 'identifying', id: null },
    identification: { phase: 'inconclusive', active: false, available: true, reason: 'probe-energy-limit' } };
  panel.update(status(item));
  assert.equal($('charger1-identification-state').textContent, 'Inconclusive');
  assert.match($('charger1-identification-status').textContent, /energy budget.*current charging choice.*until unplugging.*arrive later/);
  assert.match($('charger1-identification-status').textContent, /No further automatic tests.*choose Identify for an explicit retry/);
  assert.equal($('charger1-notice').textContent, 'Identification inconclusive');
  assert.doesNotMatch($('charger1-state').textContent, /Identifying|inconclusive/);
  assert(!$('charger1-identify').disabled, 'Only an explicit retry can request another test');
  for (const [reason, expected] of [['bmw-home-unknown', /home location report is needed/], ['bmw-away', /latest valid BMW location is away/],
    ['bmw-not-plugged', /plugged-in state/], ['vehicle-feed-stale', /feed is not current/]]) {
    item.identification = { phase: 'waiting', active: true, available: false, reason };
    panel.update(status(item)); assert.match($('charger1-identification-status').textContent, expected);
  }
  panel.close();
});

test('Tesla identified at Charger 1 leaves physical Charger 2 independent', () => {
  const document=documentFixture(),$=id=>document.getElementById(id),panel=createChargingPanel({document,request:async()=>{}});
  const one={...active(),vehicle:{state:'identified',id:'tesla',label:'Tesla',source:'teslamate'}};
  const two=charger('charger2',{vehicle:{state:'disconnected'},values:{connected:reading(false)}});
  panel.update(status(one,two));
  assert.equal($('charger1-vehicle').textContent,'Easee · Tesla identified');
  assert.equal($('charger2-title').textContent,'Charger 2');
  assert.doesNotMatch($('charger2-vehicle').textContent,/Tesla/);
  assert.equal($('charger2-soc').textContent,'—');panel.close();
});

test('session drafts are discarded when the connection or request revision changes', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = [];
  const panel = createChargingPanel({ document, request: async (...args) => { calls.push(args); return status(active()); } });
  const item = active(); panel.update(status(item));
  const field = $('charger1-setting-capacityKwh'); field.value = '68'; field.dispatch('input');
  panel.update(status({ ...item, request: { ...item.request, sessionId: 'next-session' } }));
  assert.equal(field.value, item.settings.capacityKwh); assert($('charger1-settings-save').disabled);
  assert.match($('charger1-settings-message').textContent, /session changed/);
  await submit($('charger1-settings-form')); assert.deepEqual(calls, []);
  field.value = '62'; field.dispatch('input');
  panel.update(status({ ...item, request: { ...item.request, sessionId: 'next-session', revision: 2 } }));
  assert.equal(field.value, item.settings.capacityKwh); assert($('charger1-settings-save').disabled);
  panel.close();
});

test('session edits show configuration defaults separately and never offer a lasting save', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = [];
  const item = active(); item.defaults = { ...item.settings };
  const panel = createChargingPanel({ document, request: async (path, payload) => {
    calls.push([path, payload]); return status({ ...item, settings: { ...item.settings, capacityKwh: 62 },
      request: { ...item.request, revision: 2, overrides: { capacityKwh: 62 } } });
  } });
  panel.update(status(item));
  const field = $('charger1-setting-capacityKwh'); field.value = '62'; field.dispatch('input');
  assert.equal($('charger1-settings-save').textContent, 'Save for this session');
  await submit($('charger1-settings-form'));
  assert.deepEqual(calls, [['/api/charging/chargers/charger1/settings', sessionPayload('charger1', { capacityKwh: 62 })]]);
  assert.equal(field.value, 62);
  assert.match($('charger1-setting-capacityKwh-help').textContent, new RegExp(`Configured default: ${item.defaults.capacityKwh} kWh`));
  assert.match($('charger1-settings-message').textContent, /Configured defaults are unchanged/);
  assert.equal($('charger1-session-save'), null);
  assert.equal($('charger1-enabled').tagName, 'BUTTON'); assert($('charger1-enabled').listeners.has('click'));
  panel.close();
});

test('disconnected chargers keep defaults visible and cannot submit session edits', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = [];
  const panel = createChargingPanel({ document, request: async (...args) => { calls.push(args); return status(); } });
  panel.update(status({ ...charger(), request: null }));
  for (const { key } of chargingFields) assert($(`charger1-setting-${key}`).disabled);
  assert.equal($('charger1-setting-minimumSoc').value, 80);
  const field = $('charger1-setting-manualSoc'); field.value = '42'; field.dispatch('input');
  await submit($('charger1-settings-form')); assert.deepEqual(calls, []);
  assert($('charger1-settings-save').disabled); panel.close();
});

test('expanded last reported charge explains why the current charging estimate is higher', () => {
  const document = documentFixture(), $ = id => document.getElementById(id), panel = createChargingPanel({ document, request: async () => {} });
  const item = active();
  panel.update(status({ ...item, vehicle: { state: 'identified', id: 'bmw', label: 'BMW', source: 'bmw-cardata' },
    values: { ...item.values, soc: reading(85, 'bmw-cardata', { measuredAt: now - 3600_000 }), minimumSoc: reading(95, 'bmw-cardata') },
    progress: { deliveredGridKwh: 3.5, remainingGridKwh: 5, estimatedSoc: 89, hasEnergyEstimate: true } }));
  assert.equal($('charger1-soc').textContent, '≈89 %'); assert.equal($('charger1-minimum').textContent, '95 %');
  const readings = $('charger1-readings');
  assert.match(readings.textContent, /Last reported charge85 % · BMW CarData · measured 15 Sept 2026, 20:00/);
  const label = descendants(readings).find(node => node.tagName === 'DT' && node.textContent === 'Last reported charge');
  assert.match(openDetail(label).textContent, /main charge estimate adds measured energy.*not necessarily the session’s starting charge/);
  panel.close();
});

test('charge summary explanations update without disturbing form drafts, fold state or keyboard focus', () => {
  const document = documentFixture(), $ = id => document.getElementById(id), panel = createChargingPanel({ document, request: async () => status() });
  const two = charger('charger2'), vehicle = { ...two, values: { ...two.values, connected: reading(true), soc: reading(62, 'teslamate', { measuredAt: now - 60_000 }) } };
  panel.update(status(active(), vehicle));
  const device = $('charger2-device'), field = $('charger1-setting-manualSoc');
  device.open = false; $('charger1-device').open = true; field.value = '45'; field.dispatch('input');
  const help = $('charger2-charge-label'), trigger = help.querySelector('.status-detail-trigger');
  const click = trigger.dispatch('click'), popup = $('status-detail-popover');
  assert(click.defaultPrevented, 'Opening an explanation cancels the enclosing fold action');
  assert.equal(popup.hidden, false); assert.equal(device.open, false);
  const close = popup.querySelector('.status-detail-close'), popupBody = popup.querySelector('.status-detail-body');
  assert.equal(document.activeElement, close);
  popup.scrollTop = 42; popupBody.scrollTop = 18;
  panel.update(status(active(), { ...vehicle, settings: { ...vehicle.settings, manualSoc: 22 }, values: { ...vehicle.values, soc: reading(63, 'teslamate', { measuredAt: now }) } }));
  document.flushFrames();
  assert.equal($('charger2-charge-label').querySelector('.status-detail-trigger'), trigger);
  assert.equal($('status-detail-popover'), popup); assert.equal(popup.hidden, false); assert.equal(popup.showCount, 1);
  assert.match(popupBody.textContent, /TeslaMate/); assert.match(popupBody.textContent, /Charge measured .*21:00/);
  assert.match($('charger2-setting-manualSoc-help').textContent, /Configured default: 22 %/);
  assert.equal(popup.scrollTop, 42); assert.equal(popupBody.scrollTop, 18); assert.equal(document.activeElement, close);
  assert.equal($('charger1-setting-manualSoc'), field); assert.equal(field.value, '45'); assert.equal(device.open, false);
  assert.equal($('charger2-setting-manualSoc').value, 63); assert(!$('charger2-setting-manualSoc').disabled);
  const escape = document.dispatch('keydown', { key: 'Escape' });
  assert(escape.defaultPrevented); assert.equal(popup.hidden, true); assert.equal(document.activeElement, trigger);
  assert(!document.getElementById('charger2-source-info') && !document.getElementById('charger2-completion-info'));
  panel.close();
});


test('both chargers keep daily charge, timing, energy and cost in the summary and preferences in the fold', () => {
  const document = documentFixture(), $ = id => document.getElementById(id), panel = createChargingPanel({ document, request: async () => status() });
  panel.update(status()); assert(!$('charger1-overview').hidden); assert($('charger1-reading-time').hidden);
  assert.equal($('charger1-soc').textContent, '—'); assert.equal($('charger1-energy').textContent, '—');
  assert.equal($('charger1-enabled-label').textContent, 'Automatic charging');
  assert.equal($('charger1-resume'), null); assert.equal($('charger2-resume'), null);
  const item = active(), two = charger('charger2');
  item.values.soc = reading(20, 'mqtt', { measuredAt: now - 86400_000 });
  item.plan.costCents = 207; item.control = { phase: 'waiting', owned: { startAt } };
  const observed = { ...two, values: { ...two.values, connected: reading(true), scheduledStartAt: reading(startAt) },
    forecast: { state: 'forecast', controlled: false, finishAt: deadlineAt - 2 * 3600_000 } };
  panel.update(status(item, observed)); assert(!$('charger1-overview').hidden);
  assert.equal($('charger1-soc').textContent, '20 %'); assert.equal($('charger1-minimum').textContent, '80 %');
  assert.match($('charger1-reading-time').textContent, /14 Sept 2026, 21:00/);
  assert.equal($('charger1-deadline').textContent, 'tomorrow 06:00');
  assert.equal($('charger1-sources').textContent, 'Vehicle MQTT');
  assert.equal($('charger1-state').textContent, 'Controlled');
  assert.equal($('charger2-state').textContent, 'Observed');
  assert.equal($('charger1-summary'), null); assert.equal($('charger2-summary'), null);
  assert.equal($('charger1-completion').textContent, 'tomorrow 06:00'); assert.equal($('charger2-completion').textContent, 'tomorrow 04:00');
  assert.equal($('charger1-energy').textContent, '32.9 kWh'); assert.equal($('charger1-cost').textContent, '€2.07');
  assert.equal($('charger1-periods').hidden, false, 'The only charging period remains visible in details');
  assert.match($('charger1-periods').textContent, /Period 123:00 onwards/);
  assert.equal($('charger1-deadline').parentElement.hidden, false); assert.equal($('charger2-deadline').parentElement.hidden, true);
  for (const id of ['charger1', 'charger2']) {
    const device = $(`${id}-device`), summary = $(`${id}-device-summary`), body = $(`${id}-settings-details`), overview = $(`${id}-overview`);
    assert.equal(device.tagName, 'DETAILS'); assert.equal(summary.tagName, 'SUMMARY'); assert.equal(body.tagName, 'DIV');
    assert.deepEqual(device.children, [summary, body]);
    assert(overview.contains($(`${id}-soc`)) && overview.contains($(`${id}-minimum`)) && overview.contains($(`${id}-completion`)));
    assert.notEqual($(`${id}-soc`).parentElement, $(`${id}-minimum`).parentElement, 'Charge and target have separate metric columns');
    assert.equal($(`${id}-event`).parentElement, $(`${id}-deadline`).parentElement.parentElement, 'Start and ready-by share a timing row');
    assert.equal($(`${id}-event-label`).textContent, 'Starts'); assert.equal($(`${id}-event-value`).textContent, '23:00');
    assert(summary.contains($(`${id}-remaining`)) && summary.contains($(`${id}-energy`)) && body.contains($(`${id}-reading-time`)));
    assert(summary.contains($(`${id}-delivered`)) && summary.contains($(`${id}-cost`)), 'Both roles expose all three daily energy and cost facts');
    assert(summary.textContent.includes('kWh'), 'Energy is visible before expanding details');
    assert(body.contains($(`${id}-settings-form`)));
    assert(!descendants(summary).some(node => ['INPUT', 'FORM', 'DETAILS', 'A'].includes(node.tagName)));
    const buttons = descendants(summary).filter(node => node.tagName === 'BUTTON');
    assert(buttons.length >= 9);
    assert(buttons.every(node => (node.matches('.status-detail-trigger') || node.id === `${id}-charge-now`) && node.type === 'button'), 'Summary controls explain readings or toggle Charge now');
    assert.equal($(`${id}-resume`), null, 'Both chargers use Automatic charging for manual handover');
    for (const label of ['charge', 'target', 'completion', 'delivered', 'energy', 'cost']) {
      const root = $(`${id}-${label}-label`), popup = openDetail(root);
      assert(summary.contains(root)); assert.equal(popup.getAttribute('role'), 'dialog');
      document.dispatch('keydown', { key: 'Escape' });
      assert.equal(document.activeElement, root.querySelector('.status-detail-trigger'));
    }
    assert.deepEqual(descendants(body).filter(node => node.tagName === 'DETAILS').map(node => node.id), [`${id}-explanation-details`]);
  }
  panel.update(status({ ...item, control: { phase: 'released' }, values: { ...item.values, charging: reading(true), powerKw: reading(8.2) } },
    { ...observed, values: { ...observed.values, charging: reading(true), powerKw: reading(11.2) } }));
  for (const id of ['charger1', 'charger2']) {
    assert.match($(`${id}-event`).textContent, /^Charging · /);
    assert.doesNotMatch($(`${id}-event`).textContent, /estimated/);
    assert.equal($(`${id}-device-summary`).textContent.split($(`${id}-completion`).textContent).length - 1, id === 'charger1' ? 2 : 1,
      'The estimate appears only in its metric; ready-by can independently match the estimate');
  }
  panel.close();
});

test('observed charger energy and cost use the same detail metrics with complete forecast rate coverage', () => {
  const document = documentFixture(), $ = id => document.getElementById(id), panel = createChargingPanel({ document, request: async () => status() });
  const item = charger('charger2'), finishAt = startAt + 2 * 3600_000;
  const observed = { ...item, values: { ...item.values, connected: reading(true), scheduledStartAt: reading(startAt) },
    sessionCost: { recordedGridKwh: 4 }, progress: { deliveredGridKwh: 4, remainingGridKwh: 32 }, forecast: { state: 'forecast', controlled: false, startAt, finishAt } };
  const snapshot = { ...status(active(), observed), prices: [
    { start: startAt, end: startAt + 3600_000, allInCentsPerKWh: 5 },
    { start: startAt + 3600_000, end: finishAt, allInCentsPerKWh: 15 },
  ] };
  panel.update(snapshot);
  assert.equal($('charger2-state').textContent, 'Observed'); assert.equal($('charger2-completion').textContent, 'tomorrow 01:00');
  assert.equal($('charger2-delivered').textContent, '4 kWh'); assert.equal($('charger2-energy').textContent, '32 kWh');
  assert.equal($('charger2-cost').textContent, '€3.20', '32 kWh at an average rate of 10 cents per kWh');
  assert.doesNotMatch($('charger2-readings').textContent, /Delivered since charge reference/);
  assert.equal($('charger2-delivered').parentElement.parentElement, $('charger2-cost').parentElement.parentElement);
  panel.update({ ...snapshot, prices: snapshot.prices.slice(0, 1) });
  assert.equal($('charger2-cost').textContent, 'No estimate', 'Partial price coverage never produces a partial total');
  assert.equal($('charger2-completion').textContent, 'tomorrow 01:00', 'Missing rates do not remove an otherwise valid completion forecast');
  panel.close();
});

test('compact operational facts keep their explanations and focus through the transition into charging', () => {
  const document = documentFixture(), $ = id => document.getElementById(id), panel = createChargingPanel({ document, request: async () => status() });
  const item = active(); item.capabilities.externalLoadBalancing = true;
  item.control = { phase: 'waiting', owned: { startAt } };
  item.values = { ...item.values, maximumCurrentA: reading(16), availableCurrentA: reading(23, 'easee-equalizer', { receivedAt: now }) };
  panel.update(status(item)); $('charger1-device').open = true;
  const readings = $('charger1-readings'), allowance = readings.children.find(node => node.tagName === 'DT' && node.textContent === 'Reported allowance');
  assert(allowance); assert.equal(readings.children[readings.children.indexOf(allowance) + 1].textContent, '23 A per phase');
  assert.doesNotMatch(readings.textContent, /received/);
  const popup = openDetail(allowance), trigger = allowance.querySelector('.status-detail-trigger');
  assert.match(popup.textContent, /23 A per phase · received 21:00/);
  panel.update(status({ ...item, values: { ...item.values, charging: reading(true), powerKw: reading(11), actualCurrentA: reading(16),
    availableCurrentA: reading(22, 'easee-equalizer', { receivedAt: now + 60_000 }) } }));
  document.flushFrames();
  assert.match(readings.textContent, /^Drawing now16 A per phaseReported allowance22 A per phase/);
  const refreshed = readings.children.find(node => node.tagName === 'DT' && node.textContent === 'Reported allowance');
  assert(refreshed.querySelector('.status-detail-trigger') === trigger, 'Adding a live-current row retains the existing explanation trigger');
  assert.equal(popup.hidden, false); assert.match(popup.textContent, /22 A per phase · received 21:01/);
  document.dispatch('keydown', { key: 'Escape' }); assert.equal(document.activeElement, trigger); assert(trigger.isConnected);
  panel.close();
});

test('Added energy keeps the recorded connection total after a new battery reading and expired ready-by', () => {
  const document = documentFixture(), $ = id => document.getElementById(id);
  const panel = createChargingPanel({ document, request: async () => status() });
  const item = active();
  item.sessionCost = { recordedGridKwh: 18.4, deliveredGridKwh: 20 };
  item.progress = { deliveredGridKwh: 0, remainingGridKwh: 0, estimatedSoc: 80 };
  item.values = { ...item.values, connected: reading(true), charging: reading(false) };
  item.control = { phase: 'released' };
  item.plan = { deadlineAt: now - 3600_000, state: 'release' };
  panel.update(status(item));
  assert.equal($('charger1-delivered').textContent, '18.4 kWh', 'Cost-only estimated missing energy is not presented as measured energy');
  panel.update(status({ ...item, values: { ...item.values, connected: reading(false) }, sessionCost: null }));
  assert.equal($('charger1-delivered').textContent, '—');
  panel.close();
});

function priorityStatus(priority = 'balanced', revision = 1) {
  const snapshot = status(connected(), connected('charger2')); snapshot.charging.settings.priority = priority; snapshot.charging.revision = revision;
  snapshot.charging.controls = { priority, revision };
  return snapshot;
}
function choosePriority(document, value) {
  for (const choice of ['balanced', 'charger1', 'charger2']) document.getElementById(`charging-priority-${choice}`).checked = choice === value;
  const radio = document.getElementById(`charging-priority-${value}`); radio.focus(); radio.dispatch('change');
  return radio;
}

test('shared priority stays in charger details and opens one accessible dialog outside the Garage content', () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = [];
  const panel = createChargingPanel({ document, request: async (...args) => { calls.push(args); return priorityStatus(); } });
  panel.update(priorityStatus());
  assert.equal($('charging-priority'), null, 'No standalone selector adds an overview row');
  assert.equal($('charging-priority-dialog'), null, 'The editor is created only when opened');
  assert.deepEqual($('charging-devices').children.map(node => node.id), ['charger1-device', 'charger2-device']);
  for (const id of ['charger1', 'charger2']) {
    const entry = $(`${id}-shared-priority`);
    assert.equal(entry.tagName, 'BUTTON'); assert.equal(entry.type, 'button');
    assert.equal(entry.getAttribute('aria-haspopup'), 'dialog');
    assert($(`${id}-settings-details`).contains(entry));
    assert(!$(`${id}-device-summary`).contains(entry), 'The compact summary gains no charging preference control');
    assert.equal($(`${id}-shared-priority-value`).textContent, 'Balanced');
  }
  const first = $('charger1-shared-priority'); first.focus(); first.dispatch('click');
  const dialog = $('charging-priority-dialog');
  assert.equal(dialog.tagName, 'DIALOG'); assert.equal(dialog.parentElement, document.body); assert.equal(dialog.open, true);
  assert.equal(first.getAttribute('aria-controls'), dialog.id);
  assert($('charging-priority-balanced').checked); assert($('charging-priority-save').disabled);
  choosePriority(document, 'charger2'); assert.deepEqual(calls, [], 'Choosing a draft does not mutate charging');
  $('charging-priority-cancel').dispatch('click'); assert.equal(dialog.open, false); assert(document.activeElement === first, 'Cancel returns focus to the entry');
  const second = $('charger2-shared-priority'); second.focus(); second.dispatch('click');
  assert.equal($('charging-priority-dialog'), dialog, 'Both chargers open the same global editor');
  assert($('charging-priority-balanced').checked, 'Cancelling discards the uncommitted selection');
  assert.equal(descendants(document.body).filter(node => node.id === 'charging-priority-dialog').length, 1);
  const cancel = dialog.dispatch('cancel'); assert(!cancel.defaultPrevented); dialog.close();
  assert(document.activeElement === second, 'Escape returns focus to the entry that opened the editor'); assert.deepEqual(calls, []);
  panel.close(); assert.equal($('charging-priority-dialog'), null); assert(!first.listeners.has('click'));
});

test('shared priority saves only on submit and updates both entries from the acknowledged preference', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = []; let complete;
  const panel = createChargingPanel({ document, request: (path, payload) => {
    calls.push([path, payload]); return new Promise(resolve => { complete = resolve; });
  } });
  panel.update(priorityStatus()); const entry = $('charger2-shared-priority'); entry.focus(); entry.dispatch('click');
  choosePriority(document, 'charger2');
  assert.equal($('charger1-shared-priority-value').textContent, 'Balanced');
  assert.equal($('charger2-shared-priority-value').textContent, 'Balanced');
  const saving = submit($('charging-priority-form'));
  assert.deepEqual(calls, [['/api/charging/settings', { priority: 'charger2', revision: 1, associations: { charger1: 'fixture:charger1', charger2: 'fixture:charger2' } }]]);
  assert($('charging-priority-save').disabled); assert($('charging-priority-cancel').disabled);
  assert($('charging-priority-balanced').disabled); assert($('charger1-enabled').disabled); assert($('charger2-setting-readyBy').disabled);
  assert($('charging-priority-dialog').dispatch('cancel').defaultPrevented, 'Native Escape cannot dismiss an in-flight save');
  await submit($('charging-priority-form')); await $('charger1-enabled').listeners.get('click')();
  assert.equal(calls.length, 1, 'The shared charging mutation lock prevents duplicate and competing requests');
  complete(priorityStatus('charger2', 2)); await saving;
  assert.equal($('charging-priority-dialog').open, false); assert(document.activeElement === entry, 'Save returns focus after re-enabling the invoking entry');
  assert.equal($('charger1-shared-priority-value').textContent, 'Charger 2');
  assert.equal($('charger2-shared-priority-value').textContent, 'Charger 2');
  assert(!$('charger1-enabled').disabled); assert(!$('charger2-setting-readyBy').disabled);
  $('charger1-shared-priority').dispatch('click'); assert($('charging-priority-charger2').checked);
  panel.close();
});

test('priority polling follows committed changes until edited and then preserves the open draft and focus', () => {
  const document = documentFixture(), $ = id => document.getElementById(id);
  const panel = createChargingPanel({ document, request: async () => priorityStatus() });
  panel.update(priorityStatus()); $('charger1-shared-priority').dispatch('click');
  const dialog = $('charging-priority-dialog');
  panel.update(priorityStatus('charger1', 2));
  assert($('charging-priority-charger1').checked, 'A pristine editor follows the authoritative preference');
  assert($('charging-priority-save').disabled);
  const draft = choosePriority(document, 'charger2');
  panel.update(priorityStatus('balanced', 3));
  assert.equal($('charging-priority-dialog'), dialog); assert.equal(dialog.open, true);
  assert(draft.checked); assert.equal(document.activeElement, draft); assert(!$('charging-priority-save').disabled);
  assert.equal($('charger1-shared-priority-value').textContent, 'Balanced');
  assert.equal($('charger2-shared-priority-value').textContent, 'Balanced');
  panel.update(priorityStatus('charger1', 2));
  assert.equal($('charger1-shared-priority-value').textContent, 'Balanced', 'Older snapshots cannot roll back the committed preference');
  assert(draft.checked);
  $('charging-priority-cancel').dispatch('click'); $('charger2-shared-priority').dispatch('click');
  assert($('charging-priority-balanced').checked); assert($('charging-priority-save').disabled);
  panel.close();
});

test('a failed shared-priority save retains the draft, reports the error and allows retry', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = [];
  const panel = createChargingPanel({ document, request: async (path, payload) => {
    calls.push([path, payload]); if (calls.length === 1) throw new Error('The controller could not be reached.');
    return priorityStatus(payload.priority, 2);
  } });
  panel.update(priorityStatus()); $('charger1-shared-priority').dispatch('click'); choosePriority(document, 'charger1');
  await submit($('charging-priority-form'));
  assert.equal($('charging-priority-dialog').open, true); assert($('charging-priority-charger1').checked);
  assert.match($('charging-priority-message').textContent, /controller could not be reached/);
  assert($('charging-priority-message').matches('.form-error'));
  assert(!$('charging-priority-save').disabled); assert(!$('charging-priority-charger1').disabled);
  assert.equal($('charger1-shared-priority-value').textContent, 'Balanced');
  await submit($('charging-priority-form'));
  assert.equal(calls.length, 2); assert.deepEqual(calls[1], calls[0]);
  assert.equal($('charging-priority-dialog').open, false);
  assert.equal($('charger1-shared-priority-value').textContent, 'Charger 1');
  assert.equal($('charger2-shared-priority-value').textContent, 'Charger 1');
  panel.close();
});

test('priority stays inspectable while replica and read-only transitions lock every mutation', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = [];
  const panel = createChargingPanel({ document, request: async (...args) => { calls.push(args); return priorityStatus(); } });
  panel.update(priorityStatus()); $('charger1-shared-priority').dispatch('click'); choosePriority(document, 'charger2');
  for (const snapshot of [
    { ...priorityStatus(), role: 'slave' },
    { ...priorityStatus(), readOnly: true },
    (() => { const snapshot = priorityStatus(); snapshot.charging.readOnly = true; return snapshot; })(),
  ]) {
    panel.update(snapshot);
    assert(!$('charger1-shared-priority').disabled, 'Read-only users can inspect the shared policy');
    for (const value of ['balanced', 'charger1', 'charger2']) assert($(`charging-priority-${value}`).disabled);
    assert($('charging-priority-save').disabled); assert(!$('charging-priority-cancel').disabled);
    await submit($('charging-priority-form')); assert.deepEqual(calls, []);
    assert($('charging-priority-charger2').checked, 'A permission transition does not erase the unsaved draft');
  }
  $('charging-priority-cancel').dispatch('click'); $('charger2-shared-priority').dispatch('click');
  assert.equal($('charging-priority-dialog').open, true); assert($('charging-priority-save').disabled);
  panel.update(priorityStatus()); assert(!$('charging-priority-charger1').disabled);
  choosePriority(document, 'charger1'); assert(!$('charging-priority-save').disabled);
  panel.close();
});

test('a charger-settings save locks the shared priority editor and releases it without losing the draft', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = []; let complete;
  const panel = createChargingPanel({ document, request: (path, payload) => {
    calls.push([path, payload]); return new Promise(resolve => { complete = resolve; });
  } });
  panel.update(priorityStatus()); const field = $('charger1-setting-manualSoc'); field.value = '45'; field.dispatch('input');
  $('charger1-shared-priority').dispatch('click'); choosePriority(document, 'charger2');
  const saving = submit($('charger1-settings-form'));
  assert.deepEqual(calls, [['/api/charging/chargers/charger1/settings', sessionPayload('charger1', { manualSoc: 45 })]]);
  assert($('charging-priority-save').disabled); assert($('charging-priority-charger2').disabled);
  await submit($('charging-priority-form')); assert.equal(calls.length, 1);
  const acknowledged = priorityStatus('balanced', 2); acknowledged.charging.chargers[0].settings.manualSoc = 45;
  complete(acknowledged); await saving;
  assert.equal($('charging-priority-dialog').open, true); assert($('charging-priority-charger2').checked);
  assert(!$('charging-priority-save').disabled); assert(!$('charging-priority-charger2').disabled);
  panel.close();
});

test('a superseded priority response cannot close the editor or claim its draft became authoritative', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id); let complete;
  const panel = createChargingPanel({ document, request: () => new Promise(resolve => { complete = resolve; }) });
  panel.update(priorityStatus()); $('charger1-shared-priority').dispatch('click'); choosePriority(document, 'charger2');
  const saving = submit($('charging-priority-form'));
  panel.update(priorityStatus('charger1', 3));
  complete(priorityStatus('charger2', 2)); await saving;
  assert.equal($('charging-priority-dialog').open, true); assert($('charging-priority-charger2').checked);
  assert.equal($('charger1-shared-priority-value').textContent, 'Charger 1');
  assert.equal($('charger2-shared-priority-value').textContent, 'Charger 1');
  assert.match($('charging-priority-message').textContent, /confirm|changed/i);
  assert(!$('charging-priority-save').disabled, 'The user can review and retry an unconfirmed preference');
  panel.close();
});

const clickAction = node => node.listeners.get('click')({ preventDefault() {}, stopPropagation() {} });
test('Identify follows session settings, supports an identified vehicle with automatic OFF, and serializes its fenced request', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = []; let finish;
  const item = { ...connected(), vehicle: { state: 'identified', id: 'bmw', label: 'BMW' },
    identification: { phase: 'completed', available: true, active: false, attempted: true } };
  const panel = createChargingPanel({ document, request: (...args) => { calls.push(args); return new Promise(resolve => { finish = resolve; }); } });
  panel.update(status(item));
  const controls = $('charger1-charging-controls'), body = $('charger1-settings-details'), button = $('charger1-identify');
  assert(body.children.indexOf($('charger1-session-settings')) < body.children.indexOf(controls));
  assert.equal(descendants(controls).filter(node => node.tagName === 'BUTTON').at(-1), button);
  assert.equal(controls.children.at(-1), $('charger1-identification'));
  assert.equal($('charger1-identification-title').textContent, 'Identification');
  assert.equal($('charger1-identification').getAttribute('aria-labelledby'), 'charger1-identification-title');
  assert.equal(button.textContent, 'Identify'); assert.equal(button.disabled, false);
  assert.match($('charger1-identification-status').textContent, /short charging test.*automatic scheduling off.*stop instructions keep priority/s);
  const pending = clickAction(button);
  assert.deepEqual(calls, [['/api/charging/chargers/charger1/identify', { association: item.association, sessionId: item.request.sessionId, revision: 1 }]]);
  assert(button.disabled); assert($('charger1-charge-now').disabled); assert($('charger1-settings-save').disabled);
  await clickAction(button); assert.equal(calls.length, 1);
  finish(status({ ...item, identification: { phase: 'pausing', available: true, active: true, attempted: true } })); await pending;
  assert(button.disabled); assert.equal($('charger1-vehicle').textContent, 'Easee · BMW identified');
  assert.equal($('charger1-identification-state').textContent, 'Confirming');
  assert.match($('charger1-identification-status').textContent, /brief pause.*vehicle stop evidence.*90-second deadline.*identity ends the pause sooner.*charging choice then resumes.*BMW event reports may arrive later/);
  assert.match($('charger1-state').textContent, /Identifying/);
  panel.close(); assert(!button.listeners.has('click'));
});

test('identification remains pending while waiting and an inconclusive result stays visible with Charge now or automatic OFF', () => {
  const document = documentFixture(), $ = id => document.getElementById(id);
  const panel = createChargingPanel({ document, request: async () => {} });
  const item = connected(); item.request.chargeNow = true;
  panel.update(status({ ...item, identification: { phase: 'waiting', reason: 'waiting-for-charging', active: true, available: false } }));
  assert.match($('charger1-vehicle').textContent, /Identification pending/);
  assert.match($('charger1-identification-status').textContent, /vehicle to start charging.*timer/);
  assert.match($('charger1-state').textContent, /Charge now/);
  assert.equal($('charger1-charge-now-state').textContent, 'ON'); assert($('charger1-identify').disabled);
  panel.update(status({ ...item, identification: { phase: 'inconclusive', active: false, available: true, attempted: true } }));
  assert.match($('charger1-vehicle').textContent, /Identification inconclusive/);
  assert.equal($('charger1-notice').textContent, 'Identification inconclusive');
  assert.match($('charger1-identification-status').textContent, /current charging choice now applies/);
  assert(!$('charger1-identify').disabled); panel.close();
});

test('identification exhaustion explains passive matching without implying a confirmed pause failed', () => {
  for (const [reason, explanation] of [['interrupted', /test ended without identifying this vehicle/],
    ['pause-timeout', /vehicle was not identified within the brief pause deadline/]]) {
    const display = view({ ...connected(), identification: { phase: 'inconclusive', active: false, available: true, reason } });
    assert.match(display.identification.detail, explanation);
    assert.match(display.identification.detail, /No further automatic tests.*Matching vehicle reports are still accepted.*explicit retry/);
    assert.doesNotMatch(display.identification.detail, /physical.*pause was not confirmed/);
  }
});

test('identification keeps the charging wait while general pause recovery belongs in How charging works', () => {
  const document = documentFixture(), $ = id => document.getElementById(id);
  const panel = createChargingPanel({ document, request: async () => {} });
  const items = ['charger1', 'charger2'].map(id => ({ ...connected(id), identification: {
    phase: 'waiting', reason: 'waiting-for-charging', active: true, available: true,
    pauseRecovery: id === 'charger1' ? 'charger' : 'controller', pauseOutstanding: false } }));
  panel.update(status(...items));
  for (const item of items) {
    assert.equal(view(item).event, 'Waiting for charging');
    assert.equal($(`${item.id}-identification-state`).textContent, 'Pending');
    assert.match($(`${item.id}-identification-status`).textContent, /vehicle to start charging.*timer/);
    assert.equal($(`${item.id}-identify`).getAttribute('aria-describedby'), `${item.id}-identification-status`);
    assert.equal($(`${item.id}-identification-recovery`), null);
    assert.doesNotMatch($(`${item.id}-identification`).textContent, /loses contact|expires automatically/);
    assert($(`${item.id}-explanation-details`).textContent.includes('Pause recovery'));
  }
  assert.match($('charger1-explanations').textContent, /one-off start.*scheduled time.*loses contact/);
  assert.match($('charger2-explanations').textContent, /loses contact with Shelly.*remain paused.*resume it in Shelly/);
  const popup = openDetail($('charger2-event-value'));
  assert.match(popup.textContent, /Waiting for charging.*vehicle to start charging.*timer/s);
  panel.update(status(...items.map(({ identification, ...item }) => item)));
  assert.match($('charger2-explanations').textContent, /do not expire.*resume it in Shelly/);
  panel.update(status({ ...items[0], control: { snapshot: { transport: 'ocpp' } } }, items[1]));
  assert.match($('charger1-explanations').textContent, /local charger connection.*expires automatically/);
  assert.doesNotMatch($('charger1-explanations').textContent, /one-off start/);
  panel.close();
});

test('Shelly pause recovery remains explicit after identification completes or times out and while connectivity is unknown', () => {
  const document = documentFixture(), $ = id => document.getElementById(id);
  const panel = createChargingPanel({ document, request: async () => {} });
  for (const phase of ['completed', 'inconclusive']) for (const connectedValue of [true, null]) {
    const item = { ...connected('charger2'), vehicle: { state: 'identified', id: 'tesla', label: 'Tesla' },
      identification: { phase, active: false, available: true, pauseOutstanding: true, pauseRecovery: 'controller', reason: 'charger-unavailable' },
      control: { phase: 'unavailable' } };
    item.values.connected = reading(connectedValue);
    panel.update(status(item));
    assert.equal($('charger2-identification-state').textContent, 'Recovery pending');
    assert.equal($('charger2-notice').textContent, 'Pause recovery pending');
    assert.match($('charger2-identification-status').textContent, /pause is awaiting confirmation.*when the charger is reachable/);
    assert.doesNotMatch($('charger2-identification-status').textContent, /has resumed|now applies|Connect a vehicle/);
    assert($('charger2-identify').disabled);
  }
  const ready = { ...connected('charger2'), identification: { phase: 'completed', active: false, available: true,
    pauseOutstanding: false, pauseRecovery: 'controller' } };
  panel.update(status(ready)); assert(!$('charger2-identify').disabled);
  assert.equal($('charger2-identification-state').textContent, 'Ready');
  panel.update(status({ ...ready, identification: { ...ready.identification, pauseOutstanding: true },
    control: { phase: 'uncertain', reason: 'identification-resume-required' } }));
  assert.equal($('charger2-identification-state').textContent, 'Review required');
  assert.equal($('charger2-notice').textContent, 'Review charger pause');
  assert.match($('charger2-identification-status').textContent, /another stop instruction may be active.*Review the charger.*Use automatic.*button in Charging controls/);
  assert.doesNotMatch($('charger2-identification-status').textContent, /will restore|has resumed/);
  assert.equal($('charger2-resume'), null); assert(!$('charger2-enabled').disabled);
  assert($('charger2-identify').disabled);
  panel.close();
});

test('Identify respects availability, ongoing work, read-only authority and the connected session', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = [];
  const panel = createChargingPanel({ document, request: async (...args) => { calls.push(args); } });
  const item = { ...connected(), identification: { phase: 'completed', active: false, available: true } };
  for (const snapshot of [
    { ...status(item), role: 'slave' }, { ...status(item), readOnly: true }, status({ ...item, readOnly: true }),
    status({ ...item, request: null }), status({ ...item, values: { ...item.values, connected: reading(false) } }),
    status({ ...item, identification: { ...item.identification, available: false } }),
    status({ ...item, identification: { ...item.identification, active: true, phase: 'charging' } }),
  ]) {
    panel.update(snapshot); assert($('charger1-identify').disabled);
    await clickAction($('charger1-identify')); assert.deepEqual(calls, []);
  }
  panel.update(status(item)); assert(!$('charger1-identify').disabled); panel.close();
});

test('an identification request failure preserves identity and allows a retry without claiming a test started', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id);
  const panel = createChargingPanel({ document, request: async () => { throw new Error('The connection changed. Review it before trying again.'); } });
  panel.update(status({ ...connected(), vehicle: { state: 'identified', id: 'tesla', label: 'Tesla' },
    identification: { phase: 'completed', active: false, available: true } }));
  await clickAction($('charger1-identify'));
  assert.match($('charger1-vehicle').textContent, /Tesla identified/);
  assert.match($('charger1-identification-message').textContent, /connection changed/);
  assert($('charger1-identification-message').matches('.form-error')); assert(!$('charger1-identify').disabled);
  panel.close();
});

test('Charge now toggles the current session without adding confirmation messages or a second summary action', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = [];
  const item = active();
  const panel = createChargingPanel({ document, request: async (path, payload) => {
    calls.push([path, payload]); return status({ ...item, request: { ...item.request, chargeNow: path.endsWith('/charge-now') } });
  } });
  panel.update(status(item));
  const button = $('charger1-charge-now'), indicator = $('charger1-charge-now-state'), summary = $('charger1-device-summary');
  assert(summary.contains(button)); assert(!summary.contains($('charger1-state')));
  assert.equal(button.textContent, 'Charge nowOFF'); assert.equal(button.disabled, false);
  assert.equal(button.getAttribute('aria-label'), 'Charge now'); assert.equal(indicator.getAttribute('aria-hidden'), 'true');
  assert.equal(button.title, 'Turn on immediate charging until unplugging.');
  assert.equal(button.getAttribute('aria-pressed'), 'false'); assert.equal($('charger1-resume'), null);
  await clickAction(button);
  assert.deepEqual(calls[0], ['/api/charging/chargers/charger1/charge-now', { association: item.association, sessionId: item.request.sessionId, revision: 1 }]);
  assert.equal(button.textContent, 'Charge nowON'); assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(button.getAttribute('aria-label'), 'Charge now', 'The accessible toggle name stays stable');
  assert.equal(button.title, 'Charge now is on until unplugging. Turn off to use automatic charging.');
  assert(!button.disabled); assert.equal($('charger1-resume'), null); assert(!summary.contains($('charger1-resume')));
  assert.equal($('charger1-control-message').textContent, '');
  assert.equal($('charger1-soc').textContent, '20 %');
  for (const charging of [false, true, null]) {
    panel.update(status({ ...item, request: { ...item.request, chargeNow: true }, values: { ...item.values, charging: reading(charging) } }));
    assert.equal(button.getAttribute('aria-pressed'), 'true', 'Polling retains the selected toggle');
    assert.equal(indicator.textContent, 'ON', 'ON describes the request independently of physical charging');
  }
  await clickAction(button);
  assert.deepEqual(calls[1], ['/api/charging/chargers/charger1/resume', {}]);
  assert.equal(button.textContent, 'Charge nowOFF'); assert.equal(button.disabled, false); assert.equal($('charger1-resume'), null);
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal($('charger1-control-message').textContent, '');
  panel.update(status({ ...item, control: { phase: 'yielded', manual: { kind: 'stop' } } }));
  assert.equal($('charger1-resume'), null);
  assert.equal($('charger1-enabled').getAttribute('aria-checked'), 'true', 'A manual instruction does not turn Automatic off');
  panel.close();
});

test('Charge now serializes requests, leaves details closed, and reports failure without claiming success', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = []; let reject;
  const panel = createChargingPanel({ document, request: (...args) => { calls.push(args); return new Promise((resolve, fail) => { reject = fail; }); } });
  panel.update(status(active())); const button = $('charger1-charge-now');
  const pending = clickAction(button); assert(button.disabled); assert($('charger1-setting-readyBy').disabled);
  assert.equal($('charger1-charge-now-state').textContent, 'OFF', 'A pending request is not shown as accepted');
  assert.equal($('charger1-control-message').textContent, '', 'Saving does not add a row');
  await clickAction(button); assert.equal(calls.length, 1); assert(!$('charger1-device').open);
  reject(new Error('The charger could not confirm the instruction.')); await pending;
  assert.equal(button.disabled, false); assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal($('charger1-charge-now-state').textContent, 'OFF');
  assert.equal($('charger1-control-message').textContent, 'Action failed');
  assert.match(openDetail($('charger1-control-message')).textContent, /could not confirm/);
  assert($('charger1-control-message').matches('.form-error')); panel.close();
});

test('Charge now obeys primary, capability and connection boundaries', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = [];
  const panel = createChargingPanel({ document, request: async (...args) => { calls.push(args); return status(active()); } });
  const item = active();
  for (const snapshot of [
    { ...status(item), role: 'slave' }, { ...status(item), readOnly: true },
    status({ ...item, readOnly: true }),
    status({ ...item, values: { ...item.values, connected: reading(false) } }),
    status({ ...item, request: null }), status({ ...item, capabilities: { scheduling: false } }),
  ]) {
    for (const chargeNow of [false, true]) {
      const current = structuredClone(snapshot);
      if (current.charging.chargers[0].request) current.charging.chargers[0].request.chargeNow = chargeNow;
      panel.update(current); assert($('charger1-charge-now').disabled);
      await clickAction($('charger1-charge-now')); assert.deepEqual(calls, []);
    }
  }
  panel.update(status(item)); assert(!$('charger1-charge-now').disabled); panel.close();
});

test('automatic charging is a persistent fenced control, separate from the four session fields', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = [];
  const item = charger(); item.controls = { enabled: false, revision: 3 };
  const panel = createChargingPanel({ document, request: async (path, payload) => {
    calls.push([path, payload]); return status({ ...item, controls: { enabled: payload.enabled, revision: 4 },
      settings: { ...item.settings, enabled: payload.enabled } });
  } });
  panel.update(status(item)); const toggle = $('charger1-enabled');
  assert.equal(toggle.getAttribute('role'), 'switch'); assert.equal(toggle.getAttribute('aria-checked'), 'false');
  assert.equal(toggle.disabled, false, 'Automatic charging can be chosen before a vehicle connects');
  assert(!$('charger1-settings-form').contains(toggle));
  await clickAction(toggle);
  assert.deepEqual(calls, [['/api/charging/chargers/charger1/control', { association: item.association, revision: 3, enabled: true }]]);
  assert.equal(toggle.getAttribute('aria-checked'), 'true');
  assert.equal($('charger1-control-message').textContent, 'Preference saved');
  assert.match(openDetail($('charger1-control-message')).textContent, /stays in effect until changed/);
  assert.match($('charger1-control-detail').textContent, /stays in effect until changed/);
  assert.match($('charger1-explanations').textContent, /unplugging and restart/);
  panel.update({ ...status(item), role: 'slave' }); assert(toggle.disabled);
  await clickAction(toggle); assert.equal(calls.length, 1); panel.close();
});

test('compact charger receipts retain full accessible text for 24 hours independently of live warnings', async () => {
  for (const fail of [false, true]) {
    const document = documentFixture(), $ = id => document.getElementById(id); let finish;
    const item = { ...active(), control: { phase: 'unavailable', reason: 'The last schedule is awaiting confirmation.' } };
    const message = fail ? 'The preference could not be saved. Review the current charging instruction before retrying.'
      : 'Automatic charging preference saved. It stays in effect until changed.';
    const panel = createChargingPanel({ document, request: () => new Promise((resolve, reject) => {
      finish = () => fail ? reject(new Error(message)) : resolve(status(item));
    }) });
    panel.update(status(item));
    const receipt = $('charger1-control-message'), pending = clickAction($('charger1-enabled'));
    assert.equal(receipt.getAttribute('role'), 'status'); assert.equal(receipt.textContent, 'Saving…');
    finish(); await pending;
    assert.equal(receipt.textContent, fail ? 'Action failed' : 'Preference saved');
    const popup = openDetail(receipt), trigger = receipt.querySelector('button');
    assert(popup.textContent.includes(message)); assert.equal(trigger.getAttribute('aria-label'), `${message} Show details`);
    assert(!$('charger1-device').open, 'Opening the receipt leaves charger details folded');
    panel.update({ ...status(item), now: now + 24 * 3600_000 - 1 });
    assert.equal(receipt.querySelector('button'), trigger); assert(!popup.hidden);
    assert.equal($('charger1-notice').textContent, 'Charger needs attention');
    panel.update({ ...status(item), now: now + 24 * 3600_000 });
    assert.equal(receipt.textContent, ''); assert(!receipt.matches('.form-error')); assert(popup.hidden);
    assert.equal($('charger1-notice').textContent, 'Charger needs attention', 'Receipt expiry does not dismiss a live fault');
    panel.close();
  }
});

test('Charge now works with automatic OFF and toggling back enables automatic charging', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = [];
  let item = active(); item.settings.enabled = false; item.controls = { enabled: false, revision: 4 };
  const panel = createChargingPanel({ document, request: async (path, payload) => {
    calls.push([path, payload]);
    item = { ...item, settings: { ...item.settings, enabled: path.endsWith('/control') || item.settings.enabled },
      controls: { enabled: path.endsWith('/control') || item.settings.enabled, revision: 5 },
      request: { ...item.request, chargeNow: path.endsWith('/resume') ? false : path.endsWith('/charge-now') || item.request.chargeNow }, control: { phase: 'released' } };
    return status(item);
  } });
  panel.update(status(item)); const button = $('charger1-charge-now');
  assert.equal(button.disabled, false); assert(button.matches('.secondary-button'));
  await clickAction(button);
  assert.equal($('charger1-enabled').getAttribute('aria-checked'), 'false');
  assert.equal(button.getAttribute('aria-pressed'), 'true'); assert.equal($('charger1-resume'), null);
  assert.match($('charger1-notice').textContent, /Charge now selected/);
  assert.match($('charger1-state').textContent, /Charge now/);
  await clickAction(button);
  assert.deepEqual(calls[1], ['/api/charging/chargers/charger1/control', { association: item.association, revision: 5, enabled: true }]);
  assert.deepEqual(calls[2], ['/api/charging/chargers/charger1/resume', {}]);
  assert.equal($('charger1-enabled').getAttribute('aria-checked'), 'true');
  assert.equal(button.getAttribute('aria-pressed'), 'false'); panel.close();
});

test('a shared priority draft closes if a physical charging point is replaced', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = [];
  const panel = createChargingPanel({ document, request: async (...args) => { calls.push(args); return priorityStatus(); } });
  panel.update(priorityStatus()); $('charger1-shared-priority').dispatch('click'); choosePriority(document, 'charger1');
  const changed = priorityStatus('balanced', 2); changed.charging.chargers[0].association = 'fixture:replacement';
  panel.update(changed); assert.equal($('charging-priority-dialog').open, false);
  $('charger1-shared-priority').dispatch('click'); assert($('charging-priority-balanced').checked);
  assert($('charging-priority-save').disabled); await submit($('charging-priority-form')); assert.deepEqual(calls, []); panel.close();
});

test('toggling Charge now off holds the mutation lock through enable and native handover', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = []; let finish;
  const item = active(); item.settings.enabled = false; item.request.chargeNow = true;
  const enabled = { ...item, settings: { ...item.settings, enabled: true },
    control: { phase: 'yielded', manual: { kind: 'stop', reason: 'Native stop.' } } };
  const panel = createChargingPanel({ document, request: async (path, payload) => {
    calls.push([path, payload]); return path.endsWith('/control') ? status(enabled) : new Promise(resolve => { finish = resolve; });
  } });
  panel.update(status(item)); const pending = clickAction($('charger1-charge-now'));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls.length, 2); assert($('charger1-charge-now').disabled); assert($('charger1-enabled').disabled);
  assert.equal($('charger1-control-message').textContent, '');
  await clickAction($('charger1-charge-now')); await clickAction($('charger1-enabled')); assert.equal(calls.length, 2);
  finish(status({ ...enabled, request: { ...item.request, chargeNow: false }, control: { phase: 'waiting' } })); await pending;
  assert.equal($('charger1-control-message').textContent, ''); panel.close();
});

test('toggling Charge now off does not acknowledge a native instruction after a failed enable or changed connection', async () => {
  for (const change of ['enable-failed', 'association', 'session', 'read-only']) {
    const document = documentFixture(), $ = id => document.getElementById(id), calls = [];
    const item = active(); item.settings.enabled = false; item.request.chargeNow = true;
    const panel = createChargingPanel({ document, request: async (path, payload) => {
      calls.push([path, payload]);
      if (change === 'enable-failed') throw new Error('Enable could not be saved.');
      const enabled = { ...item, settings: { ...item.settings, enabled: true },
        ...(change === 'association' ? { association: 'new-physical-charger' } : {}),
        ...(change === 'session' ? { request: { ...item.request, sessionId: 'new-vehicle-connection' } } : {}) };
      return { ...status(enabled), ...(change === 'read-only' ? { readOnly: true } : {}) };
    } });
    panel.update(status(item)); await clickAction($('charger1-charge-now'));
    assert.equal(calls.length, 1, change); assert($('charger1-control-message').matches('.form-error'));
    assert.doesNotMatch(openDetail($('charger1-control-message')).textContent, /enabled and requested/); panel.close();
  }
});

test('a failed handover keeps acknowledged Automatic ON and explains partial success', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = [];
  const item = active(); item.settings.enabled = false; item.request.chargeNow = true;
  const enabled = { ...item, settings: { ...item.settings, enabled: true },
    control: { phase: 'yielded', manual: { kind: 'stop', reason: 'Native stop.' } } };
  const panel = createChargingPanel({ document, request: async (path, payload) => {
    calls.push([path, payload]); if (path.endsWith('/resume')) throw new Error('Fresh native confirmation is unavailable.');
    return status(enabled);
  } });
  panel.update(status(item)); await clickAction($('charger1-charge-now'));
  assert.equal(calls.length, 2); assert.equal($('charger1-enabled').getAttribute('aria-checked'), 'true');
  assert.equal($('charger1-control-message').textContent, 'Action failed');
  const popup = openDetail($('charger1-control-message'));
  assert.match(popup.textContent, /Automatic charging is on, but handover could not be completed/);
  assert.match(popup.textContent, /native confirmation/);
  assert.equal($('charger1-charge-now').getAttribute('aria-pressed'), 'true');
  assert(!$('charger1-charge-now').disabled, 'A failed handover keeps the toggle available to retry');
  assert.equal($('charger1-resume'), null); assert(!$('charger1-enabled').disabled); panel.close();
});

test('ready-by picker is inset in the editable input, uses one dialog and submits through the session save', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = [];
  const item = connected(), second = connected('charger2');
  const panel = createChargingPanel({ document, request: async (...args) => {
    calls.push(args); return status({ ...item, settings: { ...item.settings, readyBy: '23:07' } }, second);
  } });
  panel.update(status(item, second));
  const input = $('charger1-setting-readyBy'), choose = $('charger1-setting-readyBy-choose');
  assert.equal(input.type, 'text', 'The field does not open the browser-owned time dialog');
  assert.equal(input.parentElement, choose.parentElement);
  assert.equal(input.parentElement.className, 'charging-time-input');
  assert.equal(choose.textContent, '', 'The integrated icon does not add a separate Choose time label');
  assert.equal(choose.getAttribute('aria-label'), 'Choose ready-by time');
  assert.equal(input.getAttribute('aria-keyshortcuts'), 'Alt+ArrowDown');
  assert(new RegExp(`^${input.pattern}$`).test('23:59')); assert(!new RegExp(`^${input.pattern}$`).test('24:00'));
  assert.equal($('charging-time-dialog'), null);
  choose.focus(); choose.dispatch('click');
  const dialog = $('charging-time-dialog');
  assert.equal(dialog.parentElement, document.body); assert.equal(dialog.open, true);
  assert.equal(choose.getAttribute('aria-haspopup'), 'dialog'); assert.equal(choose.getAttribute('aria-controls'), dialog.id);
  assert.equal($('charging-time-hour').value, item.settings.readyBy.slice(0, 2));
  $('charging-time-hour').value = '23'; $('charging-time-minute').value = '7';
  $('charging-time-cancel').dispatch('click');
  assert.equal(dialog.open, false); assert.equal(document.activeElement, choose);
  assert.equal(input.value, item.settings.readyBy); assert($('charger1-settings-save').disabled); assert.equal(calls.length, 0);
  choose.dispatch('click'); assert.equal($('charging-time-hour').value, item.settings.readyBy.slice(0, 2));
  for (const [hour, minute] of [['24', '0'], ['-1', '0'], ['23', '60'], ['1.5', '0'], ['', '0']]) {
    $('charging-time-hour').value = hour; $('charging-time-minute').value = minute; submit($('charging-time-form'));
    assert.equal(dialog.open, true); assert.equal(input.value, item.settings.readyBy);
  }
  $('charging-time-hour').value = '23'; $('charging-time-minute').value = '7'; submit($('charging-time-form'));
  assert.equal(dialog.open, false); assert.equal(input.value, '23:07'); assert.equal(document.activeElement, choose);
  assert(!$('charger1-settings-save').disabled); assert.equal(calls.length, 0, 'Set only changes the form draft');
  panel.update(status(item, second)); assert.equal(input.value, '23:07', 'Polling preserves the time draft');
  await submit($('charger1-settings-form'));
  assert.deepEqual(calls, [['/api/charging/chargers/charger1/settings', sessionPayload('charger1', { readyBy: '23:07' })]]);
  assert($('charger1-settings-save').disabled);
  const other = $('charger2-setting-readyBy-choose'); other.dispatch('click');
  assert.equal($('charging-time-dialog'), dialog); assert.equal($('charging-time-hour').value, second.settings.readyBy.slice(0, 2));
  dialog.close(); assert.equal(document.activeElement, other);
  input.focus(); const openKey = input.dispatch('keydown', { key: 'ArrowDown', altKey: true });
  assert.equal(openKey.defaultPrevented, true); assert.equal(dialog.open, true);
  $('charging-time-cancel').dispatch('click'); assert.equal(document.activeElement, input);
  panel.close(); assert.equal($('charging-time-dialog'), null); assert(!choose.listeners.has('click'));
});

test('ready-by chooser discards open drafts when session, capability or write authority changes', () => {
  const document = documentFixture(), $ = id => document.getElementById(id);
  const item = connected(), panel = createChargingPanel({ document, request: async () => assert.fail('No request expected') });
  const nextSession = { ...item, request: { ...item.request, sessionId: 'next-session' } };
  for (const next of [status(nextSession), { ...status(item), readOnly: true }, { ...status(item), role: 'slave' },
    status({ ...item, readOnly: true }), status({ ...item, capabilities: { scheduling: false } }),
    status({ ...item, values: { ...item.values, connected: reading(false) } }), status({ ...item, request: null }),
    status(connected('charger2'))]) {
    panel.update(status(item)); $('charger1-setting-readyBy-choose').dispatch('click');
    const dialog = $('charging-time-dialog'); assert.equal(dialog.open, true);
    $('charging-time-hour').value = '23'; panel.update(next);
    assert.equal(dialog.open, false, 'An uncommitted popup cannot outlive its editable session');
    const input = $('charger1-setting-readyBy'), button = $('charger1-setting-readyBy-choose');
    if (input) {
      assert.equal(input.value, item.settings.readyBy); assert.equal(button.disabled, input.disabled);
      if (button.disabled) { button.dispatch('click'); assert.equal(dialog.open, false); }
    }
  }
  panel.close();
});

test('a lower-revision replica snapshot revokes previously writable charger settings', () => {
  const document = documentFixture(), panel = createChargingPanel({ document, request: async () => { throw new Error('No mutation allowed'); } });
  const current = status(); current.charging.revision = 20; panel.update(current);
  const recorded = status(); recorded.charging.revision = 1; recorded.role = 'slave'; recorded.readOnly = true;
  recorded.sync = { generation: 'synthetic-next-snapshot' }; panel.update(recorded);
  for (const id of ['charger1-charge-now', 'charger1-setting-manualSoc', 'charger1-setting-capacityKwh'])
    assert.equal(document.getElementById(id).disabled, true, id);
  panel.close();
});
