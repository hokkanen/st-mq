import test from 'node:test';
import assert from 'node:assert/strict';
import { chargingSettings, resolveChargingDeadline } from '../src/charging/settings.js';
import { acceptSocReading, createManualSoc, effectiveSoc } from '../src/charging/soc.js';
import { forecastCharger2, chargingPower, planCharging } from '../src/charging/planner.js';

const HOUR = 3_600_000;
const now = Date.parse('2026-01-15T00:00:00Z');
const settings = chargingSettings({ enabled: true, readinessMarginMinutes: 0,
  installation: { mainFuseA: 25, reserveA: 0, otherLoadA: 0 } });
const none = { state: 'none', startAt: null, endAt: null, phaseCurrentA: [0, 0, 0], warnings: [] };
const prices = values => values.map((price, i) => ({ start: now + i * HOUR, end: now + (i + 1) * HOUR, price }));
const input = extra => ({ now, settings, deadlineAt: now + 6 * HOUR,
  prices: prices([30, 20, 5, 5, 20, 30]), charger2: none, ...extra });

test('first-use values and all nested preferences survive JSON persistence and validation', () => {
  const first = chargingSettings();
  assert.deepEqual([first.enabled, first.minimumSoc, first.readyBy, first.capacity1Kwh, first.capacity2Kwh, first.manualSoc],
    [false, 80, '06:00', 74, 57, 40]);
  const edited = chargingSettings({ ...first, capacity1Kwh: 62, capacity2Kwh: 51, manualSoc: 46,
    mqttTopic: 'example/garage/vehicle', installation: { ...first.installation, mainFuseA: 35 } });
  assert.deepEqual(chargingSettings(JSON.parse(JSON.stringify(edited))), edited);
  assert.throws(() => chargingSettings({ minimumSoc: 101 }), /minimumSoc/);
  assert.throws(() => chargingSettings({ capacity1Kwh: 0 }), /capacity1Kwh/);
  assert.throws(() => chargingSettings({ mqttTopic: 'example/#' }), /wildcards/);
  assert.throws(() => chargingSettings({ installation: { phases: 1 } }), /Unknown/);
  assert.throws(() => chargingSettings({ readyBy: '24:00' }), /HH:mm/);
});

test('deadline resolves local dates, spring gaps and autumn ambiguity consistently', () => {
  assert.equal(resolveChargingDeadline(Date.parse('2026-01-15T05:00:00Z'), '06:00', 'Europe/Helsinki'), Date.parse('2026-01-16T04:00:00Z'));
  assert.equal(resolveChargingDeadline(Date.parse('2026-03-28T22:00:00Z'), '03:30', 'Europe/Helsinki'), Date.parse('2026-03-29T01:30:00Z'));
  assert.equal(resolveChargingDeadline(Date.parse('2026-10-24T21:00:00Z'), '03:30', 'Europe/Helsinki'), Date.parse('2026-10-25T00:30:00Z'));
});

function payload(soc, measuredAt, readingId, sequence) {
  return { vehicleId: 'charger1-vehicle', sourceId: 'vehicle-telemetry', soc, measuredAt, readingId, sequence };
}

test('MQTT keeps original old measurement times and rejects duplicates, older and mismatched readings', () => {
  const originalAt = now - 120 * 24 * HOUR;
  const first = acceptSocReading(null, JSON.stringify(payload(31, originalAt, 'reading-1')), { now });
  assert.equal(first.accepted, true);
  assert.equal(first.reading.measuredAt, originalAt);
  assert.equal(effectiveSoc({ automatic: first.reading, now }).soc, 31);
  assert.equal(acceptSocReading(first.reading, payload(31, originalAt, 'reading-1'), { now: now + HOUR }).reason, 'duplicate-reading');
  assert.equal(acceptSocReading(first.reading, payload(90, originalAt - 1, 'reading-older'), { now }).reason, 'older-reading');
  assert.equal(acceptSocReading(first.reading, { ...payload(90, now, 'reading-2'), vehicleId: 'other-vehicle' }, { now }).reason, 'identity-mismatch');
  assert.equal(acceptSocReading(first.reading, payload(101, now, 'reading-2'), { now }).reason, 'invalid-soc');
  assert.equal(acceptSocReading(first.reading, payload(90, '2026-01-15 00:00', 'reading-2'), { now }).reason, 'invalid-measurement-time');
  assert.equal(acceptSocReading(first.reading, payload(90, '2025-02-31T00:00:00Z', 'reading-2'), { now }).reason, 'invalid-measurement-time');
  assert.equal(acceptSocReading(first.reading, '{bad', { now }).reason, 'malformed-json');
});

test('unknown measurement clocks remain unknown and sequence orders cached observations', () => {
  const first = acceptSocReading(null, payload(30, null, 'reading-1', 2), { now });
  assert.equal(first.reading.measuredAt, null);
  const next = acceptSocReading(first.reading, payload(35, null, 'reading-2', 3), { now: now + HOUR });
  assert.equal(next.accepted, true);
  assert.equal(acceptSocReading(next.reading, payload(25, null, 'reading-old', 1), { now }).accepted, false);
  assert.equal(effectiveSoc({ automatic: next.reading, now }).measuredAt, null);
});

test('manual override survives restart, stores fixed expiry and keeps MQTT updates underneath', () => {
  const manual = createManualSoc(40, { now, readyBy: '06:00', timezone: 'Europe/Helsinki' });
  assert.equal(manual.expiresAt, now + 4 * HOUR);
  const saved = JSON.parse(JSON.stringify(manual));
  const automatic = acceptSocReading(null, payload(65, now + HOUR, 'reading-1'), { now: now + HOUR }).reading;
  assert.equal(effectiveSoc({ manual: saved, automatic, now: now + 3 * HOUR }).soc, 40);
  chargingSettings({ readyBy: '08:00' });
  assert.equal(saved.expiresAt, now + 4 * HOUR);
  const expired = effectiveSoc({ manual: saved, automatic, now: manual.expiresAt });
  assert.equal(expired.source, 'mqtt');
  assert.equal(expired.soc, 65);
  assert.equal(effectiveSoc({ manual: saved, now: manual.expiresAt }).assumed, true);
});

test('missing SoC uses 0% and still selects a feasible cheap future start', () => {
  const config = chargingSettings({ ...settings, capacity1Kwh: 20 });
  const plan = planCharging(input({ settings: config, soc: effectiveSoc({ now }) }));
  assert.equal(plan.soc.assumed, true);
  assert.equal(plan.requiredGridKwh, 20 * .8 / .9);
  assert.equal(plan.state, 'waiting');
  assert.equal(plan.startAt, now + 2 * HOUR);
  assert.ok(plan.finishAt < now + 4 * HOUR);
  assert.equal(plan.continueAfterMinimum, true);
  assert.equal(Object.hasOwn(plan, 'stopAt'), false);
});

test('new measured SoC reduces pending requirement while explicit overdue deadline never rolls tomorrow', () => {
  const unknown = planCharging(input({ settings: { ...settings, capacity1Kwh: 40 } }));
  const measured = planCharging(input({ settings: { ...settings, capacity1Kwh: 40 }, soc: { soc: 60, source: 'mqtt' } }));
  assert.ok(measured.requiredGridKwh < unknown.requiredGridKwh);
  const overdue = planCharging(input({ deadlineAt: now - HOUR }));
  assert.equal(overdue.deadlineAt, now - HOUR);
  assert.equal(overdue.startAt, now);
  assert.equal(overdue.reason, 'insufficient-time');
});

test('already sufficient SoC still schedules the cheapest start and never adds an end command', () => {
  const plan = planCharging(input({ soc: { soc: 90, source: 'mqtt' } }));
  assert.equal(plan.requiredGridKwh, 0);
  assert.equal(plan.startAt, now + 2 * HOUR);
  assert.equal(plan.reason, 'minimum-already-satisfied');
  assert.equal(plan.continueAfterMinimum, true);
});

test('Charger 2 zero actual power still forecasts selected 13 A rather than maximum 16 A', () => {
  const telemetry = { batteryLevel: 40, chargeLimitSoc: 80, scheduledStartAt: now + HOUR,
    requestedCurrentA: 13, maxCurrentA: 16, phases: 3, voltageV: 230,
    pluggedIn: true, atHome: true, powerKw: 0,
    fields: { batteryLevel: { sourceTime: now - HOUR }, scheduledStartAt: { receivedAt: now } } };
  const forecast = forecastCharger2({ now, deadlineAt: now + 6 * HOUR, settings, telemetry });
  assert.equal(forecast.currentA, 13);
  assert.deepEqual(forecast.phaseCurrentA, [13, 13, 13]);
  assert.equal(forecast.powerKw, 8.97);
  assert.equal(forecast.startAt, now + HOUR);
  assert.ok(forecast.endAt > forecast.startAt);
  assert.deepEqual(forecast.metadata, telemetry.fields);
  assert.equal(forecast.state, 'forecast');
});

test('obsolete or absent Charger 2 schedule/current does not become zero future load', () => {
  const forecast = forecastCharger2({ now, deadlineAt: now + 6 * HOUR, settings,
    telemetry: { pluggedIn: true, atHome: true, batteryLevel: 40, chargeLimitSoc: 80, scheduledStartAt: now - HOUR } });
  assert.equal(forecast.state, 'uncertain');
  assert.equal(forecast.startAt, now);
  assert.equal(forecast.endAt, now + 6 * HOUR);
  assert.equal(forecast.currentA, 16);
  assert.ok(forecast.warnings.some(message => message.includes('no verified upcoming start')));
});

test('overlapping Charger 2 load can select 00:00 and remain enabled through the constrained hours', () => {
  const overlap = { startAt: now + HOUR, endAt: now + 3 * HOUR, phaseCurrentA: [20, 20, 20], warnings: [] };
  const plan = planCharging(input({ deadlineAt: now + 4 * HOUR, prices: prices([10, 1, 1, 10]), charger2: overlap,
    settings: { ...settings, capacity1Kwh: 20, efficiency1: 1 }, soc: { soc: 0, assumed: true } }));
  assert.equal(plan.startAt, now);
  assert.equal(plan.state, 'release');
  assert.deepEqual(plan.intervals.map(row => row.powerKw), [11.04, 0, 0, 11.04]);
  assert.equal(plan.accounting.length, 2);
  assert.equal(plan.feasible, true);
  assert.equal(Object.hasOwn(plan, 'stopAt'), false);
});

test('phase bottleneck, six-amp threshold, circuit and shared allocation are distinct constraints', () => {
  const household = [{ start: now, end: now + HOUR, phaseCurrentA: [1, 10, 2], basis: 'history-with-both-chargers-removed' }];
  const first = chargingPower({ at: now, settings, household, charger2: none });
  assert.equal(first.currentA, 15);
  assert.deepEqual(first.phaseHeadroomA, [16, 15, 16]);
  assert.deepEqual(first.warnings, []);
  const low = chargingPower({ at: now, settings, household,
    charger2: { startAt: now, endAt: now + HOUR, phaseCurrentA: [10, 10, 10] } });
  assert.equal(low.currentA, 0);
  const shared = chargingPower({ at: now, settings, household, limits: { circuitA: 10, chargingAllocationA: 18 },
    charger2: { startAt: now, endAt: now + HOUR, phaseCurrentA: [8, 8, 8] } });
  assert.equal(shared.currentA, 7);
});

test('unknown fuse and missing prices are visible fallbacks, while OFF never requests release', () => {
  const unknown = planCharging(input({ settings: { enabled: true } }));
  assert.equal(unknown.reason, 'installation-limits-unavailable');
  assert.equal(unknown.startAt, now);
  const missing = planCharging(input({ prices: prices([10]) }));
  assert.equal(missing.reason, 'price-coverage-unavailable');
  const disabled = planCharging(input({ settings: { enabled: false }, prices: [] }));
  assert.equal(disabled.state, 'disabled');
  assert.equal(disabled.startAt, null);
});

test('power/price boundaries and readiness margin produce a partial-interval optimum', () => {
  const plan = planCharging(input({ deadlineAt: now + 3 * HOUR, prices: prices([10, 1, 10]),
    settings: { ...settings, capacity1Kwh: 13.8, minimumSoc: 100, efficiency1: 1, readinessMarginMinutes: 30 } }));
  assert.equal(plan.feasible, true);
  assert.equal(plan.requiredGridKwh, 13.8);
  assert.ok(Math.abs(plan.startAt - (now + .75 * HOUR)) < 1);
  assert.ok(Math.abs(plan.finishAt - (now + 2 * HOUR)) < 1);
  assert.equal(plan.targetAt, now + 2.5 * HOUR);
});

test('fractional mathematical start is rounded earlier to a native whole second and remains feasible', () => {
  const plan = planCharging(input({ deadlineAt: now + 3 * HOUR, prices: prices([10, 1, 20]),
    settings: { ...settings, capacity1Kwh: 14, minimumSoc: 100, efficiency1: 1 } }));
  const exact = now + 2 * HOUR - 14 / 11.04 * HOUR;
  assert.equal(plan.startAt, Math.floor(exact / 1000) * 1000);
  assert.equal(plan.startAt % 1000, 0);
  assert.equal(plan.feasible, true);
  assert.ok(plan.finishAt <= now + 2 * HOUR);
});
