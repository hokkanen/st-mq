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
const status = (...chargers) => ({ role: 'primary', now, charging: { settings: { priority: 'balanced', ...structuredClone(DEFAULT_CHARGING_SETTINGS) }, controls: { priority: 'balanced', revision: 0 },
  timezone: 'Europe/Helsinki', chargers: chargers.length ? chargers : [charger(), charger('charger2')] } });
const connected = (id = 'charger1') => { const item = charger(id); return { ...item, values: { ...item.values, connected: reading(true) } }; };
const sessionPayload = (id, changes, extra = {}) => ({ scope: 'session', association: `fixture:${id}`, sessionId: `session:${id}`, revision: 1, changes, ...extra });
const view = item => chargerDisplay(item, { now });
const active = () => { const item = charger(); return { ...item, settings: { ...item.settings, enabled: true },
  values: { ...item.values, connected: reading(true) }, plan: { startAt, finishAt: deadlineAt, deadlineAt } }; };
function bmwTarget({ mode = 'automatic', conflict = true, connectedAt = now - 60_000, rawValue = 100 } = {}) {
  const item = active(), source = mode === 'full' ? 'session-target' : conflict ? 'bmw-target-filter' : 'bmw-cardata';
  const selected = { value: mode === 'full' ? 100 : 95, source, measuredAt: now - 30_000, receivedAt: now, readingId: 'target-selected' };
  return { ...item, vehicle: { state: 'identified', id: 'bmw', label: 'BMW', source: 'bmw-cardata' },
    values: { ...item.values, minimumSoc: reading(selected.value, source, { ...selected, provider: 'bmw-cardata' }) },
    targetSelection: { connectedAt, mode, conflict, selected, lower: { ...selected, value: 95 },
      raw: { value: rawValue, measuredAt: now, receivedAt: now, readingId: 'target-raw' } } };
}

test('garage keeps cold budgets in settings and renders shared charger cards above more equipment', () => {
  const html = readFileSync(new URL('../chart/index.html', import.meta.url), 'utf8');
  assert(!html.includes('id="home-heat-pump-title"'));
  assert.match(html, /id="garage-title">Garage<span class="zone-expand" aria-hidden="true"><\/span><\/h2>/);
  assert.equal((html.match(/data-h66-summary="mode"/g) ?? []).length, 1);
  assert(!html.includes('home-tariff-status'));
  assert(!html.includes('id="garage-budget-front"')); assert(html.includes('id="garage-settings-budget-front"'));
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
  assert.equal(first.soc, '20 %'); assert.equal(first.socSource, 'Starting charge'); assert.equal(first.gridEnergy, '32.9 kWh');
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
  const paused = view({ ...item, plan: { ...item.plan, periods: pausedPeriods }, control: { phase: 'paused', owned: { startAt: pausedPeriods[0].startAt, periods: pausedPeriods } } });
  assert.equal(paused.state, 'Paused between periods'); assert.equal(paused.event, 'Resumes 23:00');
  assert.equal(paused.deadline, 'Ready by tomorrow 06:00');
  const released = view({ ...item, control: { phase: 'released' }, values: { ...item.values, charging: reading(true), powerKw: reading(8.2) } });
  assert(!released.event.includes('pauses')); assert.equal(released.periodRows.length, 0);
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
  assert.equal(Object.fromEntries(result.rows)['Delivered since starting charge'], '12 kWh from the grid');
  assert.equal(Object.fromEntries(result.rows)['Last reported charge'], '20 % · Vehicle MQTT · measured 14 Sept 2026, 21:00');
  assert.equal(result.sources, 'Estimated from vehicle charge + delivered energy');
});

test('vehicle-feed outage shows the retained connection estimate instead of the saved starting-charge default', () => {
  const item = active(), measuredAt = now - 3600_000;
  const result = view({ ...item, values: { ...item.values, soc: reading(90, 'manual-fallback') },
    progress: { deliveredGridKwh: 0, remainingGridKwh: 30, estimatedSoc: 40, hasEnergyEstimate: false,
      retainedVehicleReference: true, referenceSoc: { value: 40, source: 'bmw-cardata', measuredAt } } });
  assert.equal(result.soc, '≈40 %');
  assert.equal(result.socSource, 'Estimated from last known vehicle charge');
  assert.equal(Object.fromEntries(result.rows)['Last reported charge'], '40 % · BMW CarData · measured 15 Sept 2026, 20:00');
  assert.equal(Object.fromEntries(result.rows)['Starting charge (manual)'], undefined);
  assert.ok(result.notes.some(note => /Vehicle readings are unavailable.*Edit Starting charge/.test(note)));
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
  assert.equal(manual.soc, '≈39 %'); assert.equal(Object.fromEntries(manual.rows)['Starting charge (manual)'], '30 %');
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

test('estimated starting charge progresses beyond the requested target and identifies missing energy coverage', () => {
  const item = active(), result = view({ ...item, progress: { estimatedSoc: 91, hasEnergyEstimate: true,
    estimatedSocSource: 'starting-charge', deliveredGridKwh: 58.4, remainingGridKwh: 0,
    basis: { energyCoverageIncomplete: true } }, values: { ...item.values, charging: reading(true), powerKw: reading(8) } });
  assert.equal(result.soc, '≈91 %'); assert.equal(result.minimum, '80 %'); assert.equal(result.gridEnergy, '0 kWh');
  assert.equal(result.sources, 'Estimated from starting charge + delivered energy');
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
  assert.match(explanations['Period transitions'], /service and the Easee cloud/);
  assert.match(explanations['Price planning'], /New prices can pause automatic charging.*costs less/);
  assert.match(explanations['Price planning'], /Reaching the target or ready-by time does not stop charging/);
  assert.match(explanations['Manual priority'], /complete window, including after ready-by/);
  assert.match(explanations['Manual priority'], /until unplugging/);
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
  assert.match(details['Price planning'],/costs less/);assert.match(details['Period transitions'],/confirmed charger instructions.*Actual charging activity/);
  assert.match(details['Other charging'],/automatic scheduling off/);
  assert.match(details['Target & completion'],/does not change the vehicle’s own charge limit/);
  assert.doesNotMatch(details['Period transitions'],/Easee/);
});

test('known charger limits stay available in details while the vehicle is disconnected', () => {
  const item = charger(), disconnected = view({ ...item, capabilities: { ...item.capabilities, externalLoadBalancing: true },
    values: { ...item.values, connected: reading(false), maximumCurrentA: reading(16, 'easee'), availableCurrentA: reading(0, 'easee') } });
  assert.equal(disconnected.showMetrics, false);
  assert.equal(Object.fromEntries(disconnected.rows)['Charging limit'], '16 A per phase');
  assert.equal(Object.fromEntries(disconnected.rows)['Last reported Equalizer allowance'], '0 A per phase');
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
  document.defaultView = Object.assign(new Events(), { innerWidth: 390, innerHeight: 640, requestAnimationFrame: callback => frames.push(callback) });
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
  assert.match($('charger2-setting-minimumSoc-help').textContent, /Configured default: 80%/);
  assert.match($('charger2-setting-manualSoc-help').textContent, /Configured default: 20%/);
  for (const id of ['charger1', 'charger2']) for (const { key } of chargingFields) {
    const help = $(`${id}-setting-${key}-help`);
    assert(!help.querySelector('button'), 'Settings instructions remain inline beside their fields');
    assert.equal($(`${id}-setting-${key}`).getAttribute('aria-describedby'), help.id);
  }
  assert(!$('charger2-setting-capacityKwh').disabled); assert.equal($('charger2-enabled').tagName, 'BUTTON');
  assert.equal($('charger1-setting-manualSoc').value, 20);
  const original = $('charger2-device'); panel.update(status(connected(), connected('charger2'))); assert.equal($('charger2-device'), original);
  assert.equal($('charger2-setting-manualSoc').value, 20); assert(!$('charger2-setting-manualSoc').disabled);
  panel.update({ ...status(connected(), connected('charger2')), role: 'replica' }); assert($('charger1-charge-now').disabled); assert($('charger2-setting-manualSoc').disabled);
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

test('each charger saves its own session starting charge and capacity through the same settings form', async () => {
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
  assert(!$('charging-status').hidden); assert.match($('charging-status').textContent, /charging plan could not be updated/);
  panel.update(status()); assert($('charging-status').hidden); assert.equal($('charging-status').textContent, '');
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
  assert.match($('charger1-setting-manualSoc-help').textContent, /BMW CarData.*Configured default: 35%/);
  assert.equal($('charger1-setting-capacityKwh').value, 61); assert.equal($('charger1-setting-capacityKwh').disabled, false);
  panel.update(status({ ...saved, vehicle: { state: 'disconnected' }, values: { ...saved.values, connected: reading(false) } }));
  assert.equal($('charger1-vehicle').textContent, 'Easee · Any vehicle');
  for (const [key, value] of Object.entries({ manualSoc: 35, minimumSoc: 90, capacityKwh: 61 })) {
    assert.equal($(`charger1-setting-${key}`).value, value); assert.equal($(`charger1-setting-${key}`).disabled, true);
  }
  panel.close();
});

test('BMW target conflict is visible beside the target with raw measurement details and accurate source labels', () => {
  const document = documentFixture(), $ = id => document.getElementById(id);
  const panel = createChargingPanel({ document, request: async () => status() });
  const item = bmwTarget(); panel.update(status(item));
  assert.equal($('charger1-minimum').textContent, '95 %');
  assert.equal($('charger1-target-source').textContent, 'Held BMW target');
  const notice = $('charger1-target-notice');
  assert.equal(notice.hidden, false); assert.equal(notice.parentElement, $('charger1-device-summary'));
  assert.match(notice.textContent, /reports conflict.*Planning for 95 %.*latest report: 100 %/);
  assert.equal(notice.querySelector('button'), null, 'The conflict is inline, without opening a tooltip');
  assert.equal($('charger1-device').open, undefined, 'The notice is visible in the collapsed summary');
  assert.match($('charger1-setting-minimumSoc-help').textContent, /^Held BMW target supplies/);
  const field = $('charger1-setting-minimumSoc').parentElement;
  assert.equal($('charger1-target-controls').parentElement, field);
  assert.equal(field.querySelector('label').querySelector('button'), null, 'The planning button is outside the input label');
  const popup = openDetail($('charger1-target-label'));
  assert.match(popup.textContent, /Selected planning target: 95 %, measured 15 Sept 2026, 20:59/);
  assert.match(popup.textContent, /Latest BMW target report: 100 %, measured 15 Sept 2026, 21:00/);
  assert.match(popup.textContent, /changes planning only.*set 100% in the car/s);
  assert.match(view(item).minimumSource, /held after conflicting reports/);
  panel.update(status(bmwTarget({ mode: 'full' })));
  assert.equal($('charger1-minimum').textContent, '100 %');
  assert.equal($('charger1-target-source').textContent, 'This connection');
  assert.match($('charger1-setting-minimumSoc-help').textContent, /^Session planning choice supplies/);
  assert.match($('charger1-target-notice').textContent, /reports conflict.*Planning for 100 %/);
  assert.match(view(bmwTarget({ mode: 'full' })).targetDetail, /Planning choice: 100%, chosen 15 Sept 2026, 21:00/);
  assert.match(view(bmwTarget({ mode: 'full' })).targetDetail, /In automatic mode, planning uses/);
  panel.close();
});

test('BMW full-charge planning choice and automatic restore send only the displayed connection and mode', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = [];
  const item = bmwTarget();
  const panel = createChargingPanel({ document, request: async (path, payload) => {
    calls.push([path, payload]); return status(bmwTarget({ mode: payload.mode }));
  } });
  panel.update(status(item));
  const toggle = $('charger1-target-toggle');
  assert.equal(toggle.textContent, 'Plan for 100% this connection');
  assert.equal(toggle.type, 'button'); assert.equal(toggle.disabled, false);
  assert.match($('charger1-target-help').textContent, /this connection only.*set 100% in the car/);
  await toggle.listeners.get('click')();
  assert.deepEqual(calls[0], ['/api/charging/chargers/charger1/target', { connectedAt: item.targetSelection.connectedAt, mode: 'full' }]);
  assert.equal(toggle.textContent, 'Use automatic target again');
  assert.match($('charger1-target-help').textContent, /until unplugging.*does not change the car’s charge limit/);
  assert.match($('charger1-target-message').textContent, /Planning target updated/);
  await toggle.listeners.get('click')();
  assert.deepEqual(calls[1], ['/api/charging/chargers/charger1/target', { connectedAt: item.targetSelection.connectedAt, mode: 'automatic' }]);
  assert.equal($('charger1-minimum').textContent, '95 %');
  assert.equal(item.settings.minimumSoc, DEFAULT_CHARGING_SETTINGS.chargers.charger1.minimumSoc);
  panel.close();
});

test('BMW target actions respect read-only snapshots and serialize with other charging mutations', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = []; let finish;
  const panel = createChargingPanel({ document, request: (path, payload) => {
    calls.push([path, payload]); return new Promise(resolve => { finish = resolve; });
  } });
  for (const locked of [
    { ...status(bmwTarget()), readOnly: true },
    { ...status(bmwTarget()), role: 'replica' },
    { ...status(bmwTarget()), charging: { ...status(bmwTarget()).charging, readOnly: true } },
    status({ ...bmwTarget(), readOnly: true }),
  ]) {
    panel.update(locked); assert.equal($('charger1-target-toggle').disabled, true);
    await $('charger1-target-toggle').listeners.get('click')();
  }
  assert.deepEqual(calls, []);
  panel.update(status(bmwTarget()));
  const pending = $('charger1-target-toggle').listeners.get('click')();
  assert.equal($('charger1-target-toggle').disabled, true); assert.equal($('charger1-charge-now').disabled, true);
  await $('charger1-target-toggle').listeners.get('click')(); await $('charger1-charge-now').listeners.get('click')({ preventDefault() {}, stopPropagation() {} });
  assert.equal(calls.length, 1);
  finish(status(bmwTarget({ mode: 'full' }))); await pending;
  assert.equal($('charger1-target-toggle').disabled, false); panel.close();
});

test('BMW session target controls clear on unplug and never carry a full-charge choice to a new vehicle connection', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = [];
  const panel = createChargingPanel({ document, request: async (...args) => { calls.push(args); return status(); } });
  const full = bmwTarget({ mode: 'full' }); panel.update(status(full));
  assert.equal($('charger1-target-toggle').textContent, 'Use automatic target again');
  $('charger1-target-message').textContent = 'Planning target updated for this connection.';
  for (const patch of [
    { vehicle: { state: 'disconnected' }, values: { ...full.values, connected: reading(false) } },
    { vehicle: { state: 'unidentified' } },
    { vehicle: { state: 'identified', id: 'tesla', label: 'Tesla' } },
  ]) {
    panel.update(status({ ...full, ...patch }));
    assert.equal($('charger1-target-controls').hidden, true); assert.equal($('charger1-target-notice').hidden, true);
    assert.equal($('charger1-target-toggle').disabled, true);
    await $('charger1-target-toggle').listeners.get('click')();
    assert.equal($('charger1-target-message').textContent, '');
  }
  assert.deepEqual(calls, []);
  panel.update(status(bmwTarget({ connectedAt: now, conflict: false, rawValue: 95 })));
  assert.equal($('charger1-target-controls').hidden, false);
  assert.equal($('charger1-target-toggle').textContent, 'Plan for 100% this connection');
  assert.equal($('charger1-target-notice').hidden, true); assert.equal($('charger1-minimum').textContent, '95 %');
  panel.close();
});

test('a rejected target action reports the connection race without applying its choice to the new session', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = []; let reject;
  const first = bmwTarget(), next = bmwTarget({ connectedAt: now, conflict: false, rawValue: 95 });
  const panel = createChargingPanel({ document, request: (path, payload) => {
    calls.push([path, payload]); return new Promise((resolve, fail) => { reject = fail; });
  } });
  panel.update(status(first)); const pending = $('charger1-target-toggle').listeners.get('click')();
  panel.update(status(next)); reject(new Error('The connection changed. Review its target before saving.')); await pending;
  assert.deepEqual(calls, [['/api/charging/chargers/charger1/target', { connectedAt: first.targetSelection.connectedAt, mode: 'full' }]]);
  assert.match($('charger1-target-message').textContent, /connection changed/);
  assert.equal($('charger1-target-message').getAttribute('role'), 'status');
  assert($('charger1-target-message').className.includes('form-error'));
  assert.equal($('charger1-minimum').textContent, '95 %');
  assert.equal($('charger1-target-toggle').textContent, 'Plan for 100% this connection');
  panel.close();
});

test('BMW awaiting-stop identification explains the pending evidence while leaving saved target editable', () => {
  const document = documentFixture(), $ = id => document.getElementById(id);
  const panel = createChargingPanel({ document, request: async () => status() });
  panel.update(status({ ...active(), vehicle: { state: 'unidentified', reason: 'awaiting-stop-confirmation' } }));
  assert.match($('charger1-vehicle').textContent, /BMW identification pending/);
  const popup = openDetail($('charger1-vehicle'));
  assert.match(popup.textContent, /matching charging-stop readings from BMW and Easee.*Configured vehicle defaults remain in use/s);
  assert.equal($('charger1-setting-minimumSoc').disabled, false);
  assert.equal($('charger1-target-controls').hidden, true); panel.close();
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
  assert.match($('charger2-setting-manualSoc-help').textContent, /Configured default: 22%/);
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
  assert.equal($('charger1-resume').textContent, 'Use automatic');
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
    assert(body.contains($(`${id}-resume`)), 'External manual instructions can be handed back from details');
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
  assert.doesNotMatch($('charger2-readings').textContent, /Delivered since starting charge/);
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
    { ...priorityStatus(), role: 'replica' },
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
  assert.match($('charger1-identification-status').textContent, /short charging test.*Automatic charging off.*Manual Stop/s);
  const pending = clickAction(button);
  assert.deepEqual(calls, [['/api/charging/chargers/charger1/identify', { association: item.association, sessionId: item.request.sessionId, revision: 1 }]]);
  assert(button.disabled); assert($('charger1-charge-now').disabled); assert($('charger1-settings-save').disabled);
  await clickAction(button); assert.equal(calls.length, 1);
  finish(status({ ...item, identification: { phase: 'pausing', available: true, active: true, attempted: true } })); await pending;
  assert(button.disabled); assert.equal($('charger1-vehicle').textContent, 'Easee · BMW identified');
  assert.equal($('charger1-identification-state').textContent, 'Confirming');
  assert.match($('charger1-identification-status').textContent, /brief pause.*matching charger and vehicle readings/);
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
  assert.match($('charger1-state').textContent, /Identification pending/);
  assert.equal($('charger1-charge-now-state').textContent, 'ON'); assert($('charger1-identify').disabled);
  panel.update(status({ ...item, identification: { phase: 'inconclusive', active: false, available: true, attempted: true } }));
  assert.match($('charger1-vehicle').textContent, /Identification inconclusive/);
  assert.equal($('charger1-notice').textContent, 'Identification inconclusive');
  assert.match($('charger1-identification-status').textContent, /current charging choice now applies/);
  assert(!$('charger1-identify').disabled); panel.close();
});

test('identification summaries stay short while both charger sections explain the charging wait and their pause recovery', () => {
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
    assert.equal($(`${item.id}-identify`).getAttribute('aria-describedby'), `${item.id}-identification-status ${item.id}-identification-recovery`);
  }
  assert.match($('charger1-identification-recovery').textContent, /expires automatically/);
  assert.match($('charger2-identification-recovery').textContent, /loses contact with Shelly.*remain paused.*resume it in Shelly/);
  const popup = openDetail($('charger2-event-value'));
  assert.match(popup.textContent, /Waiting for charging.*vehicle to start charging.*timer/s);
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
    assert.match($('charger2-identification-status').textContent, /release is unconfirmed.*when the charger is reachable/);
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
  assert.match($('charger2-identification-status').textContent, /manual Stop may be active.*Review the charger.*Use automatic/);
  assert.doesNotMatch($('charger2-identification-status').textContent, /will restore|has resumed/);
  assert(!$('charger2-resume').hidden); assert(!$('charger2-resume').disabled);
  assert($('charger2-identify').disabled);
  panel.close();
});

test('Identify respects availability, ongoing work, read-only authority and the connected session', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = [];
  const panel = createChargingPanel({ document, request: async (...args) => { calls.push(args); } });
  const item = { ...connected(), identification: { phase: 'completed', active: false, available: true } };
  for (const snapshot of [
    { ...status(item), role: 'replica' }, { ...status(item), readOnly: true }, status({ ...item, readOnly: true }),
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
  assert.equal(button.getAttribute('aria-pressed'), 'false'); assert($('charger1-resume').hidden);
  await clickAction(button);
  assert.deepEqual(calls[0], ['/api/charging/chargers/charger1/charge-now', { association: item.association, sessionId: item.request.sessionId, revision: 1 }]);
  assert.equal(button.textContent, 'Charge nowON'); assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(button.getAttribute('aria-label'), 'Charge now', 'The accessible toggle name stays stable');
  assert.equal(button.title, 'Charge now is on until unplugging. Turn off to use automatic charging.');
  assert(!button.disabled); assert($('charger1-resume').hidden); assert(!summary.contains($('charger1-resume')));
  assert.equal($('charger1-control-message').textContent, '');
  assert.equal($('charger1-soc').textContent, '20 %');
  for (const charging of [false, true, null]) {
    panel.update(status({ ...item, request: { ...item.request, chargeNow: true }, values: { ...item.values, charging: reading(charging) } }));
    assert.equal(button.getAttribute('aria-pressed'), 'true', 'Polling retains the selected toggle');
    assert.equal(indicator.textContent, 'ON', 'ON describes the request independently of physical charging');
  }
  await clickAction(button);
  assert.deepEqual(calls[1], ['/api/charging/chargers/charger1/resume', {}]);
  assert.equal(button.textContent, 'Charge nowOFF'); assert.equal(button.disabled, false); assert($('charger1-resume').hidden);
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal($('charger1-control-message').textContent, '');
  panel.update(status({ ...item, control: { phase: 'yielded', manual: { kind: 'stop' } } }));
  assert(!$('charger1-resume').hidden);
  assert($('charger1-settings-details').contains($('charger1-resume')));
  await clickAction($('charger1-resume'));
  assert.deepEqual(calls[2], ['/api/charging/chargers/charger1/resume', {}]);
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
  assert.match($('charger1-control-message').textContent, /could not confirm/);
  assert($('charger1-control-message').matches('.form-error')); panel.close();
});

test('Charge now obeys primary, capability and connection boundaries', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = [];
  const panel = createChargingPanel({ document, request: async (...args) => { calls.push(args); return status(active()); } });
  const item = active();
  for (const snapshot of [
    { ...status(item), role: 'replica' }, { ...status(item), readOnly: true },
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
  assert.match($('charger1-control-message').textContent, /stays in effect until changed/);
  assert.match($('charger1-control-detail').textContent, /unplugging and restart/);
  panel.update({ ...status(item), role: 'replica' }); assert(toggle.disabled);
  await clickAction(toggle); assert.equal(calls.length, 1); panel.close();
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
  assert.equal(button.getAttribute('aria-pressed'), 'true'); assert($('charger1-resume').hidden);
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
    assert.doesNotMatch($('charger1-control-message').textContent, /enabled and requested/); panel.close();
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
  assert.match($('charger1-control-message').textContent, /Automatic charging is on, but handover could not be completed/);
  assert.match($('charger1-control-message').textContent, /native confirmation/);
  assert.equal($('charger1-charge-now').getAttribute('aria-pressed'), 'true');
  assert(!$('charger1-charge-now').disabled, 'A failed handover keeps the toggle available to retry');
  assert(!$('charger1-resume').disabled); panel.close();
});
