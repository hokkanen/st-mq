import test from 'node:test';
import assert from 'node:assert/strict';
import { describeProvider, outdoorSourceLabel, providerName, providerSeries } from '../chart/provider-status.js';
import { H66_REGISTERS } from '../src/domain/telemetry.js';
import { ELECTRICITY_FIELDS } from '../src/acquisition/devices.js';

const now = Date.parse('2026-09-07T10:00:00Z');
const options = { now, formatTime: value => new Date(value).toISOString().slice(11, 16) };

test('H66 provider catalogue covers every decoded register without claiming tariff readback', () => {
  const series = providerSeries('h66');
  const decoded = Object.values(H66_REGISTERS).map(({ signal }) => signal === 'integral' ? 'heating_integral' : signal);
  assert.deepEqual(series.flatMap(row => row.signals).sort(), decoded.sort());
  assert.deepEqual(providerSeries('husdata-h66'), series);
  assert.ok(series.every(row => row.source === 'H66' && row.label && row.unit && row.detail));
  assert.match(series.find(row => row.signals.includes('tariff_reduction_setting')).detail,
    /does not confirm that tariff control is active/);
});

test('Easee provider catalogue includes all acquired fields and separates phase energy from meter counters', () => {
  const series = providerSeries('easee');
  const signals = series.flatMap(row => row.signals);
  for (const [prefix, fields] of Object.entries(ELECTRICITY_FIELDS)) {
    for (const [, name] of fields) assert.ok(signals.includes(`${prefix}_${name}`), `${prefix}_${name}`);
    for (const phase of [1, 2, 3]) assert.ok(signals.includes(`${prefix}_energy_l${phase}`));
  }
  assert.ok(series.filter(row => row.signals.some(signal => signal.endsWith('_counter')))
    .every(row => /does not correct recorded energy or train/.test(row.detail)));
  assert.ok(series.filter(row => row.signals.some(signal => /_energy_l[123]$/.test(signal)))
    .every(row => row.source === 'Calculated from Easee' && /derives power/.test(row.detail)));
  assert.match(series.find(row => row.signals.includes('ev1_voltage_l1')).detail, /verified phase mapping/);
});

test('provider catalogue preserves market fallback and the separate weather solar source', () => {
  const market = providerSeries('market', { source: 'elering' });
  assert.equal(market[0].source, 'Elering');
  assert.match(market[0].detail, /excluding VAT.*ENTSO-E.*primary.*Elering.*backup/);
  assert.match(market[1].source, /^Calculated/);
  const weather = providerSeries('weather', { source: 'fmi', acquisition: { solarSource: 'openmeteo' } });
  assert.equal(weather[0].source, 'FMI');
  assert.equal(weather[1].source, 'Open-Meteo');
  assert.match(weather[1].detail, /earlier forecast publications, not measured sunshine/);
  assert.equal(providerSeries('weather', { acquisition: { selected: 'fmi', solarSource: 'mixed' } })[1].source,
    'FMI + Open-Meteo');
  assert.match(providerSeries('outdoor', { source: 'openmeteo' })[0].detail, /H66.*first.*FMI.*then.*Open-Meteo/);
});

test('temperature catalogue distinguishes the optional adapter and MQTT sensor history from live outdoor selection', () => {
  assert.equal(providerSeries('temperatures')[0].source, 'Configured temperature adapter');
  assert.equal(providerSeries('smartthings')[0].source, 'SmartThings');
  const mqtt = providerSeries('mqtt-temperature');
  assert.equal(mqtt[0].source, 'MQTT temperature sensor');
  assert.deepEqual(mqtt.flatMap(row => row.signals), ['indoor_temperature', 'garage_temperature', 'outdoor_temperature']);
  assert.match(mqtt.find(row => row.signals.includes('outdoor_temperature')).detail,
    /recorded for history.*Live outdoor control selects H66, FMI or Open-Meteo/);
});

test('catalogue rejects unknown names and never includes provider bodies or identifiers', () => {
  const untrusted = 'https://provider.example/?token=private-secret';
  const health = { source: untrusted, device: untrusted, body: untrusted,
    acquisition: { selected: untrusted, primary: untrusted, solarSource: untrusted } };
  for (const job of ['market', 'weather', 'outdoor', 'easee', 'h66', 'temperatures', 'mqtt-temperature', untrusted,
    'constructor', '__proto__']) {
    assert.doesNotMatch(JSON.stringify(providerSeries(job, health)), /private-secret|provider\.example|https:|constructor|__proto__/);
  }
  assert.deepEqual(providerSeries(untrusted, health), []);
  for (const job of ['market', 'weather', 'outdoor', 'temperatures']) {
    assert.doesNotThrow(() => providerSeries(job, null));
  }
});

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

test('weather card descriptions distinguish H66 sensor, nearby station and model estimate', () => {
  const common = { status: 'ok', lastSuccessAt: now };
  assert.equal(outdoorSourceLabel('husdata-h66'), 'H66 outdoor sensor');
  assert.equal(outdoorSourceLabel('fmi'), 'FMI nearby station');
  assert.equal(outdoorSourceLabel('openmeteo'), 'Open-Meteo model estimate');
  assert.match(describeProvider('outdoor', { ...common, source: 'husdata-h66' }, options).detail, /Measured by the heat pump’s outdoor sensor/);
  assert.match(describeProvider('outdoor', { ...common, source: 'fmi' }, options).detail, /Observed at a nearby weather station/);
  const modeled = describeProvider('outdoor', { ...common, source: 'openmeteo' }, options);
  assert.equal(modeled.title, 'Outdoor temperature · Open-Meteo');
  assert.match(modeled.detail, /Model estimate for the area/);
  assert.doesNotMatch(modeled.detail, /Observed|Measured/);
  assert.equal(describeProvider('weather', { ...common, source: 'fmi' }, options).title, 'Weather forecast · FMI');
  assert.equal(describeProvider('weather', { ...common, source: 'openmeteo' }, options).title, 'Weather forecast · Open-Meteo');
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

test('mixed weather fallback identifies the solar provider while keeping FMI temperature', () => {
  const common = { status: 'fallback', source: 'fmi', lastSuccessAt: now,
    acquisition: { primary: 'fmi', selected: 'fmi', solarSource: 'openmeteo', fallbackUsed: true,
      attempts: [{ source: 'fmi', status: 'incomplete' }, { source: 'openmeteo', status: 'ok' }] } };
  const result = describeProvider('weather', common, options);
  assert.equal(result.title, 'Weather forecast · FMI');
  assert.equal(result.state, 'Using backup');
  assert.match(result.detail, /Solar radiation uses the Open-Meteo forecast/);
  assert.match(result.detail, /temperature or solar forecast coverage is incomplete/);
  assert.doesNotMatch(result.detail, /price coverage/);
  common.acquisition.solarSource = 'mixed';
  assert.match(describeProvider('weather', common, options).detail, /FMI with Open-Meteo forecasts filling missing intervals/);
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
