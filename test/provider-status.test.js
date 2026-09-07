import test from 'node:test';
import assert from 'node:assert/strict';
import { describeProvider, outdoorSourceLabel, providerName } from '../chart/provider-status.js';

const now = Date.parse('2026-09-07T10:00:00Z');
const options = { now, formatTime: value => new Date(value).toISOString().slice(11, 16) };

test('healthy backup is named and its primary retry respects both cooldown and polling schedule', () => {
  const health = { status: 'fallback', source: 'elering', lastSuccessAt: now, nextAttemptAt: now + 3_600_000,
    acquisition: { primary: 'entsoe', selected: 'elering', fallbackUsed: true,
      attempts: [{ source: 'entsoe', status: 'error', error: 'HTTP-429' }, { source: 'elering', status: 'ok' }] },
    sourceBackoff: { entsoe: { nextAttemptAt: now + 1_800_000, error: 'HTTP-429' } } };
  let result = describeProvider('market', health, options);
  assert.equal(result.title, 'Electricity market · Elering');
  assert.equal(result.state, 'Using backup');
  assert.equal(result.attention, false);
  assert.match(result.detail, /ENTSO-E: rate limited \(HTTP 429\)/);
  assert.match(result.detail, /Next ENTSO-E try 11:00/);
  health.sourceBackoff.entsoe.nextAttemptAt = now + 7_200_000;
  result = describeProvider('market', health, options);
  assert.match(result.detail, /Next ENTSO-E try 12:00/);
});

test('weather card descriptions distinguish a nearby station from a house sensor or regional estimate', () => {
  const common = { status: 'ok', lastSuccessAt: now };
  assert.equal(outdoorSourceLabel('fmi'), 'FMI nearby station');
  assert.equal(outdoorSourceLabel('openweathermap'), 'OpenWeather area estimate');
  assert.match(describeProvider('outdoor', { ...common, source: 'fmi' }, options).detail, /Observed at a nearby weather station/);
  assert.match(describeProvider('outdoor', { ...common, source: 'openweathermap' }, options).detail, /Area estimate; not a house sensor/);
  assert.equal(describeProvider('weather', { ...common, source: 'fmi' }, options).title, 'Weather forecast · FMI');
});

test('missing primary configuration does not advertise a retry and both failed providers stay visible', () => {
  const health = { status: 'fallback', source: 'elering', nextAttemptAt: now + 3_600_000,
    acquisition: { primary: 'entsoe', selected: 'elering', attempts: [{ source: 'entsoe', status: 'not-configured' }] } };
  assert.doesNotMatch(describeProvider('market', health, options).detail, /Next .*try/);
  health.status = 'error'; health.error = 'HTTP-503';
  health.acquisition.attempts = [{ source: 'entsoe', status: 'error', error: 'HTTP-401' }, { source: 'elering', status: 'error', error: 'HTTP-503' }];
  const result = describeProvider('market', health, options);
  assert.equal(result.state, 'Needs attention');
  assert.equal(result.attention, true);
  assert.match(result.detail, /ENTSO-E: access denied \(HTTP 401\)/);
  assert.match(result.detail, /Elering: download failed \(HTTP 503\)/);
});

test('unknown source names, codes and provider response text cannot expose URLs or secrets in the UI', () => {
  const secret = 'https://provider.example/?token=private-secret';
  const result = describeProvider(secret, { status: secret, source: secret, error: secret,
    acquisition: { primary: 'fmi', selected: secret, attempts: [{ source: 'fmi', status: 'error', error: secret }] } }, options);
  assert.equal(providerName(secret), null);
  assert.equal(outdoorSourceLabel(secret), null);
  assert.equal(result.title, 'Data provider');
  assert.equal(result.state, 'Status pending');
  assert.doesNotMatch(JSON.stringify(result), /private-secret|provider\.example|https:/);
  assert.match(result.detail, /FMI: download failed/);
});

test('waiting providers show their scheduled download and distinguish a due request', () => {
  const health = { status: 'waiting', lastSuccessAt: now - 3_600_000, nextAttemptAt: now + 300_000 };
  const result = describeProvider('temperatures', health, options);
  assert.equal(result.state, 'Waiting');
  assert.match(result.detail, /Last successful download 09:00/);
  assert.match(result.detail, /Next download 10:05/);
  assert.equal(result.attention, false);
  health.nextAttemptAt = now;
  assert.match(describeProvider('temperatures', health, options).detail, /Download is due/);
});

test('Easee describes old readings without reporting different measurement times', () => {
  const result = describeProvider('easee', { status: 'degraded', lastSuccessAt: now, error: null,
    nextAttemptAt: now + 300_000, qualityIssues: ['stale', 'asynchronous_snapshot'] }, options);
  assert.equal(result.state, 'Needs attention');
  assert.equal(result.attention, true);
  assert.match(result.detail, /Last successful download 10:00/);
  assert.match(result.detail, /Some readings have old source timestamps/);
  assert.match(result.detail, /Charger or property readings: Some readings have old source timestamps/);
  assert.doesNotMatch(result.detail, /measured at different times|asynchronous/);
  assert.doesNotMatch(result.detail, /download failed|No successful download|Next try/);
});

test('Easee ignores timestamp mismatch and charger age in cached degraded statuses', () => {
  for (const qualityIssues of [['asynchronous_snapshot'], ['charger_stale'], ['charger_stale', 'asynchronous_snapshot']]) {
    for (const status of ['ok', 'degraded']) {
      const display = describeProvider('easee', { status, qualityIssues, error: null, failures: 1 }, options);
      assert.equal(display.state, 'Available');
      assert.equal(display.attention, false);
      assert.doesNotMatch(display.detail, /measured at different times|asynchronous/);
    }
  }
});

test('Easee shares its last complete download while naming affected readings in issues and retry', () => {
  const display = describeProvider('easee', { status: 'degraded', error: 'HTTP-429', nextAttemptAt: now + 300_000,
    lastSuccessAt: now - 3_600_000,
    currentReadings: {
      charger: { qualityIssues: ['missing', 'invalid_unit'], error: 'HTTP-429', lastSuccessAt: now - 3_600_000 },
      property: { qualityIssues: ['negative_current', 'source_time_unknown'], error: null, lastSuccessAt: now },
    } }, options);
  assert.equal(display.attention, true);
  const [download, ...issues] = display.detail.split(/\.\s*/).filter(Boolean);
  assert.equal(download, 'Last successful download 09:00');
  for (const sentence of issues) {
    assert.match(sentence, /Charger|Property|property/, sentence);
  }
  assert.equal(display.detail.match(/successful download/g).length, 1);
  assert.match(display.detail, /Charger readings: Some current readings are missing\./);
  assert.match(display.detail, /Charger readings: Some readings have unsupported units\./);
  assert.match(display.detail, /Property readings: Some current readings are negative\./);
  assert.match(display.detail, /Property readings: Some readings have no source timestamp\./);
  assert.match(display.detail, /Charger readings: Rate limited \(HTTP 429\)\./);
  assert.doesNotMatch(display.detail, /Property readings: (Rate limited|Download failed)/);
  assert.match(display.detail, /Charger and property readings: Next try 10:05\./);
});

test('scoped charger age stays informational and scopes all other current notes', () => {
  const informational = { status: 'degraded', qualityIssues: ['charger_stale', 'asynchronous_snapshot'],
    staleSourceTimes: { charger_stale: now - 90 * 60_000 },
    currentReadings: { charger: { qualityIssues: ['charger_stale', 'asynchronous_snapshot'], error: null, lastSuccessAt: now } } };
  const display = describeProvider('easee', informational, options);
  assert.equal(display.state, 'Available');
  assert.equal(display.attention, false);
  assert.match(display.detail, /Charger readings have source timestamps older than 1.5 hours\./);
  assert.doesNotMatch(display.detail, /[Pp]roperty|different times|asynchronous/);
  informational.currentReadings.charger.qualityIssues = ['stale', 'asynchronous_snapshot'];
  assert.equal(describeProvider('easee', informational, options).attention, false,
    'Generic old flags must use the known charger scope');
  for (const key of ['charger', 'property']) {
    for (const flag of ['future_source_time', 'source_time_unknown', 'implausible_current', 'negative_current',
      'invalid_numeric', 'invalid_unit', 'conflicting_duplicate', 'missing', 'provider_error', 'missing_configuration']) {
      const result = describeProvider('easee', { status: 'degraded',
        currentReadings: { [key]: { qualityIssues: [flag], error: null, lastSuccessAt: null } } }, options);
      const subject = key === 'charger' ? 'Charger' : 'Property';
      assert.equal(result.attention, true, flag);
      const [download, ...issues] = result.detail.split(/\.\s*/).filter(Boolean);
      assert.equal(download, 'No successful download recorded');
      for (const sentence of issues) assert.ok(sentence.startsWith(subject), sentence);
    }
  }
});

test('Easee waiting, unknown errors and untrusted scope fields produce only named safe sentences', () => {
  const secret = 'https://provider.example/?token=private-secret';
  const health = { status: 'waiting', nextAttemptAt: now + 300_000,
    currentReadings: { property: { qualityIssues: [], error: null, lastSuccessAt: null } } };
  assert.equal(describeProvider('easee', health, options).detail,
    'No successful download recorded. Property readings: Next download 10:05.');
  health.currentReadings.property = { qualityIssues: [secret, 'asynchronous_snapshot', 'constructor'], error: secret, lastSuccessAt: secret };
  health.currentReadings[secret] = { qualityIssues: ['missing'], error: secret };
  const display = describeProvider('easee', health, options);
  assert.match(display.detail, /Property readings: Download failed\./);
  assert.doesNotMatch(JSON.stringify(display), /private-secret|provider\.example|https:|constructor|different times/);
});

test('Easee download sentence is shared across healthy, legacy and partially successful snapshots', () => {
  for (const health of [
    { lastSuccessAt: now, currentReadings: {
      charger: { lastSuccessAt: now, qualityIssues: [] }, property: { lastSuccessAt: now, qualityIssues: [] },
    } },
    { lastSuccessAt: now, currentReadings: { charger: { lastSuccessAt: now, qualityIssues: [] } } },
    { lastSuccess: now },
  ]) {
    assert.equal(describeProvider('easee', { status: 'ok', ...health }, options).detail,
      'Last successful download 10:00.');
  }
  const partial = describeProvider('easee', { status: 'degraded', lastSuccessAt: null,
    currentReadings: {
      charger: { lastSuccessAt: now, qualityIssues: [] },
      property: { lastSuccessAt: null, qualityIssues: [], error: 'HTTP-503' },
    } }, options);
  assert.equal(partial.detail, 'No successful download recorded. Property readings: Download failed (HTTP 503).');
});

test('download errors retain retry details alongside existing reading quality warnings', () => {
  const result = describeProvider('easee', { status: 'error', lastSuccessAt: now - 3_600_000,
    error: 'HTTP-429', nextAttemptAt: now + 300_000, qualityIssues: ['stale'] }, options);
  assert.equal(result.attention, true);
  assert.match(result.detail, /Some readings have old source timestamps/);
  assert.match(result.detail, /Rate limited \(HTTP 429\)/);
  assert.match(result.detail, /Next try 10:05/);
  assert.doesNotMatch(result.detail, /Next download/);
});

test('Easee identifies old charger and property timestamps and only property staleness needs attention', () => {
  for (const [qualityIssues, status, charger, property] of [
    [['charger_stale'], 'ok', true, false],
    [['property_stale'], 'degraded', false, true],
    [['charger_stale', 'property_stale'], 'degraded', true, true],
    [[], 'ok', false, false],
  ]) {
    const result = describeProvider('easee', { status, lastSuccessAt: now, qualityIssues }, options);
    assert.equal(result.state, property ? 'Needs attention' : 'Available');
    assert.equal(result.attention, property);
    assert.equal(result.detail.includes('Charger readings have old source timestamps.'), charger);
    assert.equal(result.detail.includes('Property readings have old source timestamps.'), property);
    assert.doesNotMatch(result.detail, /Some readings have old source timestamps/);
  }
});

test('informational charger timestamps do not hide other Easee problems', () => {
  for (const health of [
    { status: 'degraded', qualityIssues: ['charger_stale', 'implausible_current'] },
    { status: 'error', qualityIssues: ['charger_stale'], error: 'HTTP-503' },
  ]) {
    const result = describeProvider('easee', { lastSuccessAt: now, ...health }, options);
    assert.equal(result.state, 'Needs attention');
    assert.equal(result.attention, true);
    assert.match(result.detail, /Charger readings have old source timestamps/);
    assert.match(result.detail, /implausible|Download failed/);
  }
});

test('source ages use completed half-hour buckets and keep charger and property ages separate', () => {
  for (const [minutes, age] of [[30, '0.5 hours'], [59.99, '0.5 hours'], [60, '1 hour'],
    [89.99, '1 hour'], [90, '1.5 hours'], [119.99, '1.5 hours'], [120, '2 hours'], [150, '2.5 hours']]) {
    const result = describeProvider('easee', { status: 'degraded', lastSuccessAt: now,
      qualityIssues: ['charger_stale', 'property_stale'],
      staleSourceTimes: { charger_stale: now - 48 * 3_600_000, property_stale: now - minutes * 60_000 } }, options);
    assert.ok(result.detail.includes(`Property readings have source timestamps older than ${age}.`), result.detail);
    assert.match(result.detail, /Charger readings have source timestamps older than 48 hours\./);
    assert.equal(result.attention, true);
  }
  const health = { status: 'degraded', qualityIssues: ['stale'], staleSourceTimes: { stale: now - 135 * 60_000 } };
  assert.match(describeProvider('temperatures', health, options).detail, /older than 2 hours\./);
  assert.match(describeProvider('temperatures', health, { ...options, now: now + 30 * 60_000 }).detail, /older than 2.5 hours\./);
});

test('missing or invalid age metadata keeps legacy warnings without displaying provider text', () => {
  for (const at of [undefined, null, NaN, Infinity, -1, 0, now + 60_000, String(now - 3_600_000),
    'https://provider.example/?token=private-secret', { value: now - 3_600_000 }]) {
    const result = describeProvider('easee', { status: 'ok', qualityIssues: ['charger_stale'],
      staleSourceTimes: { charger_stale: at } }, options);
    assert.match(result.detail, /Charger readings have old source timestamps\./);
    assert.equal(result.attention, false);
    assert.doesNotMatch(JSON.stringify(result), /private-secret|provider\.example|https:|NaN|Infinity/);
  }
});

test('quality messages are deduplicated and unknown provider text is never displayed', () => {
  const secret = 'https://provider.example/?token=private-secret';
  const health = { status: 'degraded', lastSuccessAt: now,
    qualityIssues: ['implausible_temperature', 'suspect_zero_indoor', 'implausible_temperature',
      secret, 'constructor', '__proto__', { code: secret }] };
  const result = describeProvider('temperatures', health, options);
  assert.equal(result.detail.match(/Some temperature readings are implausible\./g).length, 1);
  assert.doesNotMatch(JSON.stringify(result), /private-secret|provider\.example|https:|constructor|__proto__/);
  health.qualityIssues = secret;
  assert.doesNotMatch(describeProvider('temperatures', health, options).detail, /private-secret/);
});
