import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardProviders, temperatureReadingStatus, temperatureAttentionDetails, describeProvider } from '../chart/provider-status.js';
import { durationText, qualityReasonText } from '../chart/reading-status.js';
import { equipmentConnections, equipmentConnectionSummary } from '../chart/equipment.js';
import { createChargingTeslaCapture, teslamateVehicleTelemetry } from '../src/charging/teslamate.js';
import { ChargingRuntime } from '../src/charging/runtime.js';

const now = Date.parse('2026-09-13T12:00:00Z'), MINUTE = 60_000;
const options = { now, formatTime: at => new Date(at).toISOString().slice(11, 19) };
const indoor = (extra = {}) => ({ value: 21, observedAt: now, source: 'mqtt-temperature', stale: false, ...extra });

test('outdoor expiry uses source-specific limits in both summary and source details', () => {
  for (const [source, limit] of [['husdata-h66', 5], ['fmi', 30], ['openmeteo', 30]]) {
    const reading = { value: 4, source, observedAt: now - limit * MINUTE, stale: false };
    assert.equal(temperatureReadingStatus(reading, { ...options, outdoor: true }).usable, true);
    reading.observedAt -= 1000;
    const status = temperatureReadingStatus(reading, { ...options, outdoor: true });
    assert.equal(status.usable, false);
    assert.match(status.detail, new RegExp(`${limit} min 1 s old; limit ${limit} min`));
    const [group] = dashboardProviders({ input: 'mqtt', observations: { indoor: indoor(), outdoor: reading } }, options);
    assert.equal(group.display.state, 'Needs attention');
    assert.ok(group.series.at(-1).detail.includes(status.detail));
    assert.doesNotMatch(status.detail, /or unusable/);
  }
});

test('a stricter live H66 deadline is displayed without relaxing the recorded source policy', () => {
  const reading = { value: 4, source: 'husdata-h66', observedAt: now - 61_000, maxAgeMs: MINUTE };
  assert.match(temperatureReadingStatus(reading, { ...options, outdoor: true }).detail, /1 min 1 s old; limit 1 min/);
  reading.maxAgeMs = 60 * MINUTE;
  reading.observedAt = now - 6 * MINUTE;
  assert.match(temperatureReadingStatus(reading, { ...options, outdoor: true }).detail, /6 min old; limit 5 min/);
});

test('periodic report expiry uses the report clock, not an unchanged saved value', () => {
  const reading = indoor({ observedAt: now - 2 * 86400_000, periodicReports: true,
    lastReportAt: now - 17 * MINUTE, reportExpiresAt: now, reportMaxAgeMs: 17 * MINUTE,
    reportIntervalMs: 15 * MINUTE, reportGraceMs: 2 * MINUTE });
  assert.equal(temperatureReadingStatus(reading, options).usable, true);
  const expired = temperatureReadingStatus(reading, { ...options, now: now + 1000 });
  assert.equal(expired.usable, false);
  assert.match(expired.detail, /last report 11:43:00 \(17 min 1 s old\)/);
  assert.match(expired.detail, /limit 17 min \(15 min interval \+ 2 min grace\)/);
  assert.match(expired.detail, /overdue by 1 s/);
  assert.doesNotMatch(expired.detail, /2 d|over 2 hours/);
});

test('an unavailable average names the missing member and its reporting deadline', () => {
  const bedroom = { signal: 'bedroom_temperature', value: 20, observedAt: now - 20 * MINUTE,
    periodicReports: true, lastReportAt: now - 20 * MINUTE, reportMaxAgeMs: 17 * MINUTE,
    reportExpiresAt: now - 3 * MINUTE, reasons: ['missing-report'], stale: true };
  const average = indoor({ value: null, stale: true, periodicReports: true,
    availabilityReasons: ['missing-member'], missingMembers: [bedroom] });
  const display = temperatureReadingStatus(average, options);
  assert.match(display.detail, /Bedroom: Unavailable.*last report 11:40:00 \(20 min old\); limit 17 min/);
  const [group] = dashboardProviders({ input: 'mqtt', observations: { indoor: average,
    outdoor: { value: 4, source: 'fmi', observedAt: now, stale: false } } }, options);
  assert.equal(group.display.state, 'Needs attention');
  assert.match(group.display.detail, /Average indoor:.*Bedroom/);
});

test('invalid publications explain why the last valid nonperiodic value is being held', () => {
  const reading = indoor({ held: true, needsAttention: true, attentionReasons: ['invalid-reading'],
    lastAttemptAt: now - MINUTE, lastAttemptReasons: ['unsupported-unit'] });
  const status = temperatureReadingStatus(reading, options);
  assert.equal(status.usable, true);
  assert.match(status.detail, /Using last known reading/);
  assert.match(status.detail, /Latest publication 11:59:00 was invalid: the temperature unit is unsupported/);
});

test('missing, invalid, future, retained and sensor-change readings have distinct explanations', () => {
  for (const [extra, reason] of [
    [{ value: null, availabilityReasons: ['missing-reading'] }, /no genuine reading/i],
    [{ availabilityReasons: ['unsupported-unit'] }, /temperature unit is unsupported/],
    [{ observedAt: now + MINUTE }, /1 min in the future/],
    [{ availabilityReasons: ['retained'] }, /retained.*live report/],
    [{ availabilityReasons: ['before-sensor-change'] }, /predates the recorded sensor change/],
    [{ settling: true, settlingUntil: now + 5 * MINUTE }, /5 min remaining; settling period 30 min/],
  ]) {
    const status = temperatureReadingStatus(indoor({ stale: true, ...extra }), options);
    assert.equal(status.usable, false);
    assert.match(status.detail, reason);
    assert.doesNotMatch(status.detail, /out of date or unusable/);
  }
});

test('old nonperiodic values remain usable and historical warnings age at the saved window', () => {
  const reading = indoor({ observedAt: now - 2 * 3600_000 });
  assert.equal(temperatureReadingStatus(reading, options).attention, false);
  const older = temperatureReadingStatus(reading, { ...options, now: now + 1000 });
  assert.equal(older.usable, true);
  assert.match(older.detail, /age 2 h 1 s; attention threshold 2 h/);
  const detail = temperatureAttentionDetails([{ signal: 'bedroom_temperature', observedAt: reading.observedAt,
    reasons: ['old-reading'] }], options.formatTime, { now: now + 1000 });
  assert.match(detail, /age 2 h 1 s/);
});

test('unknown diagnostic fields cannot expose provider text or private sensor identifiers', () => {
  const untrustedFlag = 'invented-private-value';
  const reading = indoor({ stale: true, availabilityReasons: [untrustedFlag, '__proto__', 'constructor'],
    lastAttemptReasons: [untrustedFlag], missingMembers: [{ signal: untrustedFlag, reasons: [untrustedFlag] }] });
  assert.doesNotMatch(temperatureReadingStatus(reading, options).detail, /invented-private|__proto__|constructor/);
  assert.equal(qualityReasonText(untrustedFlag), null);
  assert.equal(qualityReasonText('constructor'), null);
  assert.equal(durationText(NaN), 'unknown');
});

test('Tesla vehicle feed separates live reception and logger health from unchanged field clocks', async t => {
  const capture = createChargingTeslaCapture({ clock: () => now, settings: { maxAgeMs: 3 * MINUTE } });
  capture.setConnected(true);
  const receive = (field, value, at) => capture.receive(`teslamate/cars/1/${field}`, value, {}, at);
  receive('battery_level', '80', now - 5 * MINUTE);
  receive('charge_current_request', '8', now - 5 * MINUTE);
  receive('healthy', 'true', now - 4 * MINUTE);
  receive('charger_power', '1', now);

  const runtime = new ChargingRuntime({ engine: {}, store: { getState: () => null }, clock: () => now,
    config: { input: 'mqtt', charging: { vehicles: { bmw: { mqttTopic: null } } } }, definitions: [] });
  runtime.teslaCapture = capture;
  t.after(() => runtime.close());
  const charging = runtime.status(now), [feed] = charging.vehicleFeeds;
  assert.equal(feed.id, 'tesla');
  assert.equal(feed.usedByChargerId, null);
  assert.equal(feed.reception.lastLiveAt, now);
  const connection = equipmentConnections({ now, charging }).find(row => row.kind === 'vehicle');
  assert.equal(connection.id, 'connection:vehicle:tesla:other');
  assert.equal(equipmentConnectionSummary(connection).label, 'Connected');
  assert.match(connection.connectionDetail, /sleeping or idle vehicle can remain quiet/);

  const display = describeProvider('teslamate', capture.status(), options);
  assert.equal(display.state, 'Needs attention');
  assert.match(display.detail, /health is missing or unhealthy.*Last-known vehicle values.*without control authority/);
  let evidence = teslamateVehicleTelemetry(capture.snapshot(), { now });
  assert.equal(evidence.soc.available, false);
  assert.equal(evidence.soc.lastKnownValue, 80);
  assert.equal(evidence.soc.reason, 'vehicle-logger-unhealthy');
  assert.equal(capture.snapshot().fields.healthy.receivedAt, now - 4 * MINUTE);

  receive('healthy', 'true', now);
  evidence = teslamateVehicleTelemetry(capture.snapshot(), { now });
  assert.equal(evidence.soc.available, true, 'A healthy quiet vehicle retains its change-only SoC');
  assert.equal(evidence.vehicleCurrentA.available, true, 'A healthy quiet vehicle retains its change-only current setting');
  assert.equal(evidence.vehicleCurrentA.value, 8);
  assert.equal(evidence.vehicleCurrentA.reason, null);
  assert.equal(evidence.vehicleCurrentA.receivedAt, now - 5 * MINUTE);
  assert.equal(evidence.vehicleCurrentA.retained, false);
  assert.equal(evidence.vehicleCurrentA.timeBasis, 'receipt-only');
  assert.equal(evidence.vehicleCurrentA.measuredAt, null, 'Receipt clocks do not become invented measurement clocks');
  assert.equal(capture.snapshot().fields.charge_current_request.receivedAt, now - 5 * MINUTE,
    'New live health does not rewrite the original setting observation');
});
