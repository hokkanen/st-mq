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

test('successful downloads with old or asynchronous readings explain quality separately', () => {
  const result = describeProvider('easee', { status: 'degraded', lastSuccessAt: now, error: null,
    nextAttemptAt: now + 300_000, qualityIssues: ['stale', 'asynchronous_snapshot'] }, options);
  assert.equal(result.state, 'Needs attention');
  assert.equal(result.attention, true);
  assert.match(result.detail, /Last successful download 10:00/);
  assert.match(result.detail, /Some readings have old source timestamps/);
  assert.match(result.detail, /Current readings were measured at different times/);
  assert.doesNotMatch(result.detail, /download failed|No successful download|Next try/);
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
