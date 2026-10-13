import test from 'node:test';
import assert from 'node:assert/strict';
import { chargingControlLabel, chargingControlReason, chargingVehicleFeedReason, chargingRecordedDetail } from '../chart/charging-status.js';

test('recorded charging details use the assessment date and preserve an unknown date', () => {
  const recorded = { readOnly: true, recorded: true, snapshotAt: Date.parse('2026-10-13T08:00:01Z') };
  assert.match(chargingRecordedDetail(recorded), /13 Oct 2026, 11:00:01 Europe\/Helsinki/);
  for (const snapshotAt of [undefined, null, NaN]) {
    const detail = chargingRecordedDetail({ ...recorded, snapshotAt });
    assert.match(detail, /Recorded master status \(time unavailable\)/);
    assert.doesNotMatch(detail, /1970/);
  }
  assert.equal(chargingRecordedDetail({ snapshotAt: recorded.snapshotAt }), '');
});

test('unplugged vehicle status explains its meaning separately from charger communication', () => {
  assert.equal(chargingControlLabel('disconnected'), 'No vehicle connected');
  const detail = chargingControlReason('disconnected');
  assert.match(detail, /no vehicle is plugged in/i);
  assert.match(detail, /communication connection is separate/i);
  assert.match(detail, /when a vehicle connects/i);
  assert.doesNotMatch(detail, /charger (?:offline|fault|error)/i);
});

test('unavailable charger status remains unknown and gives a useful connection check', () => {
  assert.equal(chargingControlLabel('unavailable'), 'Charger status unavailable');
  const detail = chargingControlReason('unavailable');
  assert.match(detail, /charger status is unavailable/i);
  assert.match(detail, /check.*connection.*native controls/i);
  assert.doesNotMatch(detail, /no vehicle.*plugged|ready for.*connection/i);
});

test('unrecognized status words and codes produce guidance without exposing raw reasons', () => {
  for (const reason of ['unexplained', 'UNRECOGNIZED', 'unexpected-provider-state', 'native_failure_503']) {
    const detail = chargingControlReason(reason);
    assert.equal(chargingControlLabel(reason), 'Charger needs attention');
    assert.match(detail, /status.*(?:unavailable|could not be explained)/i, reason);
    assert.match(detail, /check.*charger controls/i, reason);
    assert.ok(!detail.includes(reason), reason);
  }
});

test('malformed reasons and inherited property names cannot become popup content', () => {
  for (const reason of [{ message: 'synthetic native exception' }, ['synthetic native exception'], 503, true,
    'constructor', 'toString', '__proto__']) {
    const detail = chargingControlReason(reason), label = chargingControlLabel(reason);
    assert.equal(typeof detail, 'string');
    assert.equal(typeof label, 'string');
    assert.match(detail, /check.*charger controls/i);
    assert.doesNotMatch(`${label}\n${detail}`, /synthetic native exception|\[object Object\]|function\s|native code|constructor|toString|__proto__/);
  }
});

test('authored explanations retain their ready-by terms and full uncertainty statement', () => {
  for (const detail of [
    'The ready-by time has passed. Edit Ready by to choose a new deadline.',
    'The local charger command was cancelled; an already sent command may still take effect.',
    'The one-off charger schedule remains active; check its actual state before retrying.',
  ]) assert.equal(chargingControlReason(detail), detail);
});

test('missing optional status does not invent a warning', () => {
  for (const reason of [null, undefined, '']) {
    assert.equal(chargingControlLabel(reason), '');
    assert.equal(chargingControlReason(reason), '');
  }
});

test('an unconfirmed instruction cannot be described as a known failed physical action', () => {
  assert.match(chargingControlLabel('command-failed'), /unconfirmed/i);
  const detail = chargingControlReason('command-failed');
  assert.match(detail, /could not be confirmed/i);
  assert.match(detail, /may still have taken effect/i);
  assert.match(detail, /check.*actual state before retrying/i);
  assert.doesNotMatch(detail, /instruction failed|no effect|send.*again/i);
});

test('Shelly admission, clock and connection problems explain their cause, consequence and next check', () => {
  const cases = [
    ['evse-input-persistence-pending', /readings.*waiting to be saved/i, /new instructions wait/i, /recording.*storage/i],
    ['evse-recording-unavailable', /readings could not be saved/i, /new instructions are blocked/i, /recording.*storage/i],
    ['evse-source-time-pending', /report.*ahead.*clock/i, /new instructions wait/i, /check.*device.*controller clocks/i],
    ['evse-source-clock-unavailable', /report time cannot be used/i, /new instructions wait.*valid evidence/i, /check.*device.*controller clocks/i],
    ['evse-offline', /MQTT.*connection.*unavailable/i, /instructions cannot be confirmed/i, /check.*MQTT.*Charging setup/i],
    ['evse-request-limit', /too many requests.*awaiting replies/i, /wait.*settle/i, /check.*actual charger state before retrying/i],
  ];
  for (const [reason, cause, consequence, nextCheck] of cases) {
    const detail = chargingControlReason(reason);
    assert.match(detail, cause, reason);
    assert.match(detail, consequence, reason);
    assert.match(detail, nextCheck, reason);
    assert.ok(!detail.includes(reason), reason);
    assert.notEqual(chargingControlLabel(reason), 'Charger needs attention', reason);
  }
});

test('vehicle feed problems name the affected evidence source and give a useful check', () => {
  const cases = [
    ['mqtt-disconnected', /vehicle MQTT connection.*unavailable/i, /check.*broker/i],
    ['mqtt-subscription-failed', /MQTT subscription failed for vehicle reports/i, /check.*topic access/i],
    ['vehicle-feed-stale', /no recent vehicle report/i, /check.*publisher/i],
    ['vehicle-source-clock-pending', /vehicle report.*ahead.*clock/i, /waiting.*time can be used/i],
    ['vehicle-source-clock-unavailable', /vehicle report times cannot be used/i, /check.*publisher.*controller clocks/i],
    ['vehicle-logger-unhealthy', /vehicle logger health.*unconfirmed/i, /check.*vehicle logger/i],
  ];
  for (const [reason, cause, nextCheck] of cases) {
    const detail = chargingVehicleFeedReason(reason);
    assert.match(detail, cause, reason);
    assert.match(detail, nextCheck, reason);
    assert.ok(!detail.includes(reason), reason);
    assert.doesNotMatch(detail, /charger.*offline|vehicle.*unplugged|fresh observation/i, reason);
  }
  for (const reason of ['unknown-feed-code', 'constructor', { message: 'synthetic feed exception' }]) {
    const detail = chargingVehicleFeedReason(reason);
    assert.match(detail, /vehicle reports.*unavailable/i);
    assert.match(detail, /check.*vehicle feed/i);
    assert.doesNotMatch(detail, /unknown-feed-code|constructor|synthetic feed exception|function\s|\[object Object\]/);
  }
});
