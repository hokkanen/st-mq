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
