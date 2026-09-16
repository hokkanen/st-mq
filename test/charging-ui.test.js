import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chargerDisplay, chargingDisplay, chargingContext, chargingFields, chargingTime, chargingReadingTime, createChargingPanel } from '../chart/charging.js';
import { DEFAULT_CHARGING_SETTINGS } from '../src/charging/settings.js';

const now = Date.parse('2026-09-15T18:00:00Z'), startAt = now + 2 * 3600_000, deadlineAt = now + 9 * 3600_000;
const reading = (value, source = 'teslamate', extra = {}) => ({ value, source, available: value != null, ...extra });
function charger(id = 'charger1', patch = {}) {
  return { id, label: id === 'charger1' ? 'Charger 1' : 'Charger 2',
    provider: id === 'charger1' ? 'easee' : 'teslamate',
    settings: structuredClone(DEFAULT_CHARGING_SETTINGS.chargers[id]), capabilities: { scheduling: id === 'charger1', currentControl: false },
    values: { soc: reading(20, 'manual-fallback'), minimumSoc: reading(80, 'manual-fallback'),
      capacityKwh: reading(id === 'charger1' ? 74 : 57, 'manual-fallback'), connected: reading(null) },
    requiredGridKwh: 32.888, ...patch };
}
const status = (...chargers) => ({ role: 'primary', now, charging: { settings: structuredClone(DEFAULT_CHARGING_SETTINGS),
  timezone: 'Europe/Helsinki', chargers: chargers.length ? chargers : [charger(), charger('charger2')] } });
const view = item => chargerDisplay(item, { now });
const active = () => { const item = charger(); return { ...item, settings: { ...item.settings, enabled: true },
  values: { ...item.values, connected: reading(true) }, plan: { startAt, finishAt: deadlineAt, deadlineAt } }; };

test('garage keeps cold budgets in settings and renders shared charger cards above more equipment', () => {
  const html = readFileSync(new URL('../chart/index.html', import.meta.url), 'utf8');
  assert(!html.includes('id="home-heat-pump-title"'));
  assert.match(html, /id="garage-title">Garage<span class="zone-expand" aria-hidden="true"><\/span><\/h2>/);
  assert.equal((html.match(/<span>Heating mode<\/span>/g) ?? []).length, 1);
  assert(!html.includes('home-tariff-status'));
  assert(!html.includes('id="garage-budget-front"')); assert(html.includes('id="garage-settings-budget-front"'));
  assert(html.indexOf('id="garage-control"') < html.indexOf('id="charging-devices"'));
  assert(html.indexOf('id="charging-devices"') < html.indexOf('id="garage-equipment-details"'));
  assert.equal(html.split('id="charging-devices"').length - 1, 1, 'Chargers are mounted once in the Garage card');
  assert(!html.includes('id="charger1-settings-form"'), 'Per-charger forms come from the same renderer');
  assert(!html.includes('charging-installation'));
});

test('only local charger preferences are editable, with SoC following the same fallback field pattern', () => {
  assert.deepEqual(chargingFields.map(field => field.key), ['manualSoc', 'minimumSoc', 'readyBy', 'capacityKwh']);
  assert.equal(chargingFields.find(field => field.key === 'manualSoc').reading, 'soc');
  assert(chargingFields.find(field => field.key === 'manualSoc').automatic);
});

test('both chargers use the same compact model and retain useful energy information with control off', () => {
  const original = charger(), renamed = { ...original, id: 'another-charger', label: 'Another charger' };
  const first = view(original), second = view(renamed);
  assert.deepEqual({ ...first, id: second.id, label: second.label }, second);
  assert.equal(first.soc, '20 %'); assert.equal(first.socSource, 'Starting charge'); assert.equal(first.gridEnergy, '32.9 kWh');
  assert.equal(chargingDisplay(status().charging, now).chargers.length, 2);
  assert.equal(view(charger('charger2')).event, 'Monitoring');
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
  assert.equal(view(away).state, 'Not connected'); assert.equal(view(away).event, 'Monitoring');
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
  assert.equal(Object.fromEntries(result.rows)['Vehicle charge reading'], '20 % · Vehicle MQTT');
  assert.equal(result.sources, 'Estimated from vehicle charge + delivered energy');
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
  assert.match(explanations['Energy estimate'], /Three-phase.*90 %/);
  assert.match(explanations['Household forecast'], /older cold-weather readings remain useful/);
  assert.match(explanations['Current reference'], /details are not available yet/);
  assert.match(explanations['Current allocation'], /Equalizer controls/);
  assert.match(explanations['Period transitions'], /service and the Easee cloud/);
  assert.match(explanations['Price planning'], /final period leaves charging enabled/);
  assert.match(explanations['Manual priority'], /whichever comes first/);
  assert(!JSON.stringify(result).includes('ST-MQ'));
  assert(!Object.fromEntries(view(charger('charger2')).explanations)['Period transitions']);
});

test('monitoring explanations describe vehicle controls without unsupported scheduling or Equalizer instructions', () => {
  const observed = Object.fromEntries(view(charger('charger2')).explanations);
  for (const heading of ['Price planning', 'Manual priority', 'Ready-by time', 'Household forecast', 'Current allocation', 'Turning automatic charging off'])
    assert.equal(observed[heading], undefined, heading);
  assert.match(observed.Monitoring, /cannot start, pause or schedule/);
  assert.match(observed['Native schedule'], /does not supply a scheduled stop/);
  assert.match(observed['Connection & readings'], /plugged in at this property/);
  assert.match(observed['Charging current'], /does not change charging current/);
  assert.match(observed['Target & completion'], /does not change the vehicle’s own charge limit/);
  const unavailable = view(charger('charger2', { error: 'charging-adapter-unavailable' }));
  assert.match(unavailable.problem, /Waiting for fresh charging readings/);
  assert.doesNotMatch(unavailable.problem, /Automatic control/);
  const generic = Object.fromEntries(view(charger('charger1', { provider: 'example-provider' })).explanations);
  assert.doesNotMatch(generic['Period transitions'], /Easee/);
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
  focus() { this.document.activeElement = this; }
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
  const two = charger('charger2'); panel.update(status(charger(), { ...two, values: { ...two.values, minimumSoc: reading(85), soc: reading(62) } }));
  assert.equal($('charger1-setting-minimumSoc').value, 80); assert(!$('charger1-setting-minimumSoc').disabled);
  assert(!$('charger1-setting-readyBy').disabled); assert($('charger2-setting-readyBy').disabled);
  assert.equal($('charger2-setting-minimumSoc').value, 85); assert($('charger2-setting-minimumSoc').disabled);
  assert.equal($('charger2-setting-manualSoc').value, 62); assert($('charger2-setting-manualSoc').disabled);
  assert.match($('charger2-setting-minimumSoc-help').textContent, /Saved fallback: 80%/);
  assert.match($('charger2-setting-manualSoc-help').textContent, /Saved fallback: 20%/);
  for (const id of ['charger1', 'charger2']) for (const { key } of chargingFields) {
    const help = $(`${id}-setting-${key}-help`);
    assert(!help.querySelector('button'), 'Settings instructions remain inline beside their fields');
    assert.equal($(`${id}-setting-${key}`).getAttribute('aria-describedby'), help.id);
  }
  assert(!$('charger2-setting-capacityKwh').disabled); assert($('charger2-enabled').disabled);
  assert.equal($('charger1-setting-manualSoc').value, 20);
  const original = $('charger2-device'); panel.update(status()); assert.equal($('charger2-device'), original);
  assert.equal($('charger2-setting-manualSoc').value, 20); assert(!$('charger2-setting-manualSoc').disabled);
  panel.update({ ...status(), role: 'replica' }); assert($('charger1-enabled').disabled); assert($('charger2-setting-manualSoc').disabled);
  assert(![...document.nodes.keys()].some(id => /installation|mqtt|efficiency|soc-form|soc-automatic/.test(id)));
  panel.close(); assert(!$('charger1-enabled').listeners.has('click'));
});

test('refresh preserves a fallback edit and serializes mutations', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = []; let resolve;
  const panel = createChargingPanel({ document, request: async (path, payload) => { calls.push([path, payload]); return new Promise(done => { resolve = done; }); } });
  panel.update(status()); const device = $('charger1-device'), field = $('charger1-setting-manualSoc');
  device.open = true; field.focus(); field.value = '45'; field.listeners.get('input')();
  panel.update(status()); assert.equal(device.open, true); assert.equal(field.value, '45'); assert.equal(document.activeElement, field);
  device.open = false; panel.update(status()); assert.equal(device.open, false);
  device.open = true; assert.equal($('charger1-setting-manualSoc'), field); assert.equal(field.value, '45');
  const pending = submit($('charger1-settings-form'));
  assert.deepEqual(calls, [['/api/charging/chargers/charger1/settings', { manualSoc: 45 }]]);
  assert($('charger1-enabled').disabled); await $('charger1-enabled').listeners.get('click')(); assert.equal(calls.length, 1);
  const updated = status(); updated.charging.chargers[0].settings.manualSoc = 45; resolve(updated); await pending;
  assert.equal(field.value, 45); assert($('charger1-settings-save').disabled); panel.close();
});

test('each charger saves its own SoC fallback and capacity through the same settings form', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = [];
  const panel = createChargingPanel({ document, request: async (path, payload) => { calls.push([path, payload]);
    const two = charger('charger2'); return status(charger(), { ...two, settings: { ...two.settings, ...payload } }); } });
  panel.update(status());
  for (const [key, value] of [['capacityKwh', '59'], ['manualSoc', '42']]) {
    const field = $(`charger2-setting-${key}`); field.value = value; field.listeners.get('input')();
  }
  await submit($('charger2-settings-form'));
  assert.equal($('charger1-enabled').textContent, 'OFF'); assert.equal($('charger1-setting-manualSoc').value, 20);
  assert.deepEqual(calls, [['/api/charging/chargers/charger2/settings', { manualSoc: 42, capacityKwh: 59 }]]);
  panel.close();
});

test('a nested read-only charging snapshot locks every mutation even without a replica role', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = [];
  const panel = createChargingPanel({ document, request: async (...args) => { calls.push(args); return status(); } });
  const snapshot = status(); snapshot.charging.readOnly = true; panel.update(snapshot);
  for (const id of ['charger1-enabled', 'charger1-setting-manualSoc', 'charger2-setting-manualSoc', 'charger1-setting-capacityKwh',
    'charger2-setting-capacityKwh']) assert($(id).disabled, id);
  await $('charger1-enabled').listeners.get('click')(); await submit($('charger1-settings-form'));
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

test('automatic SoC takes priority while preserving a draft to use when automatic readings are unavailable', async () => {
  const document = documentFixture(), $ = id => document.getElementById(id), calls = [];
  const panel = createChargingPanel({ document, request: async (...args) => { calls.push(args); return status(); } });
  panel.update(status()); const field = $('charger2-setting-manualSoc'); field.value = '75'; field.listeners.get('input')();
  const two = charger('charger2'); panel.update(status(charger(), { ...two, values: { ...two.values, soc: reading(85) } }));
  assert.equal(field.value, 85); assert(field.disabled);
  await submit($('charger2-settings-form')); assert.deepEqual(calls, []);
  panel.update(status()); assert.equal(field.value, '75'); assert(!field.disabled); assert(!$('charger2-settings-save').disabled);
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
  assert.match($('charger2-setting-manualSoc-help').textContent, /Saved fallback: 22%/);
  assert.equal(popup.scrollTop, 42); assert.equal(popupBody.scrollTop, 18); assert.equal(document.activeElement, close);
  assert.equal($('charger1-setting-manualSoc'), field); assert.equal(field.value, '45'); assert.equal(device.open, false);
  assert.equal($('charger2-setting-manualSoc').value, 63); assert($('charger2-setting-manualSoc').disabled);
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
  assert.equal($('charger1-resume').textContent, 'Resume automatic charging');
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
    assert(buttons.every(node => node.matches('.status-detail-trigger') && node.type === 'button'), 'Summary controls explain readings without changing charging settings');
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
    progress: { deliveredGridKwh: 4, remainingGridKwh: 32 }, forecast: { state: 'forecast', controlled: false, startAt, finishAt } };
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
